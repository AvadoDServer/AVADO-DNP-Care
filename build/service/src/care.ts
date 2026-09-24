/**
 * The Care loop: every 10 minutes (or when the backend asks for another interval) build the
 * health snapshot, run the Admin's rules and send the signed heartbeat.
 */
import type { Config } from "./config.js";
import {
  DappmanagerError,
  fetchChainData,
  getParams,
  getStats,
  listPackages,
  signCareRequest,
} from "./dappmanager.js";
import { BackendError, buildHeartbeatPayload, parseHeartbeatResponse, postSigned, sha256Hex } from "./heartbeat.js";
import { errorMessage, type Logger } from "./log.js";
import { fetchMetrics, runHealthCheck, type CheckResult, type Verdict } from "./snapshot.js";
import type { CareState, StateStore, StatusFinding } from "./state.js";
import { fetchStorePackages } from "./store.js";
import type { WampSession } from "./wamp.js";

export const DAPPMANAGER_PACKAGE = "dappmanager.dnp.dappnode.eth";
/** Contract B: the backend mounts the care routes under /api/care. */
export const HEARTBEAT_ROUTE = "/api/care/heartbeat";

export const MESSAGES = {
  outdated:
    "Your AVADO needs a system update before it can check in with AVADO. System updates install automatically; this fixes itself after the next one.",
  dappmanager: "Your AVADO's system service did not answer. AVADO Care tries again in 10 minutes.",
  offline: "Your AVADO could not reach AVADO over the internet. AVADO Care tries again in 10 minutes.",
  clock: "Your AVADO's clock is wrong, so AVADO can't receive its check-ins.",
  signature: "AVADO could not confirm that this check-in came from your box. Check that your AVADO's date and time are right. AVADO Care tries again in 10 minutes.",
  slowDown: "AVADO asked this box to check in less often. AVADO Care tries again later.",
  unexpected: "Something went wrong while checking in. AVADO Care tries again in 10 minutes.",
} as const;

export interface CareDeps {
  openWamp(): WampSession;
  fetch: typeof fetch;
  now(): number;
  store: StateStore;
}

export interface StatusResponse {
  version: string;
  lastHeartbeat: { at: string | null; ok: boolean; error: string | null };
  verdict: Verdict;
  findings: StatusFinding[];
  subscribed: boolean | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  checking: boolean;
  /** Which inputs the last check could read ("ok", "failed", "not-installed", ...), for support. */
  sources: Record<string, string>;
}

export function toStatusFindings(check: CheckResult): StatusFinding[] {
  return check.findings.slice(0, 50).map((f) => ({
    id: String(f.id),
    severity: f.severity,
    topic: String(f.topic ?? ""),
    title: String(f.title),
    why: typeof f.why === "string" ? f.why : null,
  }));
}

export function heartbeatErrorMessage(e: unknown): string {
  if (e instanceof DappmanagerError) return e.kind === "outdated" ? MESSAGES.outdated : MESSAGES.dappmanager;
  if (e instanceof BackendError) {
    if (e.status === null) return MESSAGES.offline;
    if (e.status === 401) return MESSAGES.signature;
    if (e.status === 429) return MESSAGES.slowDown;
    if (e.status >= 500) return MESSAGES.offline;
    return MESSAGES.unexpected;
  }
  return MESSAGES.unexpected;
}

export class CareService {
  private state: CareState;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: number | null = null;
  private lastRunEndedAt = 0;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly deps: CareDeps,
    initialState: CareState,
  ) {
    this.state = initialState;
  }

  status(): StatusResponse {
    return {
      version: this.config.version,
      lastHeartbeat: { ...this.state.lastHeartbeat },
      verdict: this.state.lastCheck?.verdict ?? "checking",
      findings: this.state.lastCheck?.findings ?? [],
      subscribed: this.state.subscribed,
      lastCheckAt: this.state.lastCheck?.at ?? null,
      nextCheckAt: this.nextAt === null || this.running !== null ? null : new Date(this.nextAt).toISOString(),
      checking: this.running !== null,
      sources: { ...(this.state.lastCheck?.sources ?? {}) },
    };
  }

  get currentState(): CareState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    // a little jitter so boxes that rebooted together do not all check in at once
    this.schedule(this.config.firstRunDelayMs + Math.floor(Math.random() * 30_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /** "Check now": joins a run in progress; refuses when the last one ended less than the cooldown ago. */
  async checkNow(): Promise<{ ran: boolean }> {
    if (this.running) {
      await this.running;
      return { ran: true };
    }
    if (this.deps.now() - this.lastRunEndedAt < this.config.checkNowCooldownMs) return { ran: false };
    await this.runOnce();
    return { ran: true };
  }

  /** One full cycle. Never throws; concurrent callers share the same run. */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.cycle()
      .catch((e: unknown) => this.logger.error(`care cycle failed: ${errorMessage(e)}`))
      .then((nextInSec) => {
        this.running = null;
        this.lastRunEndedAt = this.deps.now();
        if (!this.stopped) this.schedule(this.intervalFrom(typeof nextInSec === "number" ? nextInSec : null));
      });
    this.running = run;
    return run;
  }

  private intervalFrom(nextInSec: number | null): number {
    if (nextInSec === null) return this.config.intervalMs;
    return Math.min(this.config.maxIntervalMs, Math.max(this.config.minIntervalMs, nextInSec * 1000));
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.deps.now() + ms;
    this.timer = setTimeout(() => void this.runOnce(), ms);
    this.timer.unref?.();
  }

  /** @returns the backend's nextInSec, when it sent one */
  private async cycle(): Promise<number | null> {
    const wamp = this.deps.openWamp();
    try {
      const check = await runHealthCheck(
        {
          listPackages: () => listPackages(wamp),
          getStats: () => getStats(wamp),
          getParams: () => getParams(wamp),
          fetchChainData: () => fetchChainData(wamp),
          fetchStorePackages: (nodeid, pkgs) => fetchStorePackages(this.config, nodeid, pkgs, this.deps.fetch),
          fetchMetrics: () => fetchMetrics(this.deps.fetch),
          now: this.deps.now,
        },
        this.logger,
      );
      this.state.lastCheck = { at: check.at, verdict: check.verdict, findings: toStatusFindings(check), sources: { ...check.sources } };
      const criticals = check.findings.filter((f) => f.severity === "critical").length;
      this.logger.info(`health check: ${check.verdict}, ${check.findings.length} finding(s), ${criticals} critical`);
      return await this.sendHeartbeat(wamp, check);
    } finally {
      wamp.close();
      await this.deps.store.save(this.state);
    }
  }

  private async sendHeartbeat(wamp: WampSession, check: CheckResult): Promise<number | null> {
    const at = new Date(this.deps.now()).toISOString();
    const dappmanager = check.snapshot.packages.find((p) => p.name === DAPPMANAGER_PACKAGE);
    const dappmanagerVersion = dappmanager?.version ?? null;
    if (this.state.outdatedDappmanager && this.state.outdatedDappmanager === dappmanagerVersion) {
      this.state.lastHeartbeat = { at, ok: false, error: MESSAGES.outdated };
      return null;
    }

    const payload = JSON.stringify(buildHeartbeatPayload(check, this.config.version));
    try {
      const json = await this.signAndPost(wamp, payload, dappmanagerVersion);
      const res = parseHeartbeatResponse(json);
      if (!res.ok) throw new BackendError("the heartbeat was not accepted", 200);
      this.state.subscribed = res.subscribed;
      this.state.lastHeartbeat = { at, ok: true, error: null };
      this.state.lastSuccessAt = at;
      this.logger.info(`heartbeat sent (${res.subscribed ? "Priority Care active" : "not subscribed"})`);
      return res.nextInSec;
    } catch (e) {
      this.state.lastHeartbeat = { at, ok: false, error: e instanceof ClockError ? MESSAGES.clock : heartbeatErrorMessage(e) };
      this.logger.warn(`heartbeat failed: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * Signs the payload through the DAPPMANAGER (contract A) and posts it (contract B). When the
   * backend refuses the timestamp (401 with its serverTime), re-signs once with the backend's
   * clock and retries once. If the DAPPMANAGER then refuses that timestamp (its own ±10 min
   * check), the box's clock is wrong: ClockError.
   */
  private async signAndPost(wamp: WampSession, payload: string, dappmanagerVersion: string | null): Promise<unknown> {
    const hash = sha256Hex(payload);
    const sign = async (timestamp: number) => {
      try {
        const sig = await signCareRequest(wamp, "care-heartbeat", timestamp, hash);
        this.state.outdatedDappmanager = null;
        return sig;
      } catch (e) {
        if (e instanceof DappmanagerError && e.kind === "outdated") this.state.outdatedDappmanager = dappmanagerVersion ?? "unknown";
        throw e;
      }
    };
    const post = async (timestamp: number) => {
      const sig = await sign(timestamp);
      return postSigned(this.config.backendUrl, HEARTBEAT_ROUTE, { ...sig, payload }, this.deps.fetch);
    };

    try {
      return await post(Math.floor(this.deps.now() / 1000));
    } catch (e) {
      if (!(e instanceof BackendError) || e.status !== 401 || e.serverTime === null) throw e;
      const refusedAt = this.deps.now();
      this.logger.warn("heartbeat: the backend refused this box's time; retrying once with the backend's clock");
      const timestamp = e.serverTime + Math.max(0, Math.round((this.deps.now() - refusedAt) / 1000));
      let sig;
      try {
        sig = await sign(timestamp);
      } catch (signError) {
        if (signError instanceof DappmanagerError && signError.kind === "rejected") throw new ClockError(signError.message);
        throw signError;
      }
      return postSigned(this.config.backendUrl, HEARTBEAT_ROUTE, { ...sig, payload }, this.deps.fetch);
    }
  }
}

/** The DAPPMANAGER refused to sign with the backend's time: the box's clock is off by more than 10 minutes. */
export class ClockError extends Error {}
