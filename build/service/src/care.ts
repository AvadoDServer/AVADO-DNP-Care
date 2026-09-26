/**
 * The Care loop: every 10 minutes (or when the backend asks for another interval) build the
 * health snapshot, run the Admin's rules and send the signed heartbeat.
 *
 * Load and noise limits (see inputs.ts): the package list and the store catalogue are read at
 * most hourly; inputs that keep failing pause for 6 hours; while the DAPPMANAGER cannot sign
 * care requests yet, the whole check runs hourly; while the box clock is known to be wrong,
 * signing is tried again only every 6 hours.
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
import { BACKOFF_MS, CHECK_NOW_PACKAGES_TTL_MS, Inputs, type SourceName } from "./inputs.js";
import { fetchFeeRecipients, VALIDATOR_CLIENTS } from "./admin/health/feeRecipients.js";
import { trackUpdateAges } from "./admin/health/updateAges.js";
import { errorMessage, type Logger } from "./log.js";
import { carryOverFindings, failedSources, fetchMetrics, runHealthCheck, type CarrySource, type CheckResult, type Verdict } from "./snapshot.js";
import type { CareState, HeartbeatIssue, StateStore, StatusFinding } from "./state.js";
import { fetchStorePackages } from "./store.js";
import type { WampSession } from "./wamp.js";

export const DAPPMANAGER_PACKAGE = "dappmanager.dnp.dappnode.eth";
/** Contract B: the backend mounts the care routes under /api/care. */
export const HEARTBEAT_ROUTE = "/api/care/heartbeat";
/** Checks run hourly while the DAPPMANAGER cannot sign care requests yet. */
export const OUTDATED_INTERVAL_MS = 60 * 60 * 1000;
/** A backend time this far from the box clock cannot be signed (the DAPPMANAGER allows ±10 min). */
export const MAX_CLOCK_SKEW_SEC = 9 * 60;
/** Previous findings of a failing input are carried over for at most this long. */
export const CARRY_MAX_MS = 24 * 60 * 60 * 1000;

export const MESSAGES: Record<HeartbeatIssue, string> = {
  outdated: "Your AVADO needs a system update before it can check in with AVADO. This starts working after your next AVADO system update.",
  dappmanager: "Your AVADO's system service did not answer. AVADO Care tries again shortly.",
  offline: "Your AVADO could not reach AVADO over the internet. AVADO Care tries again in 10 minutes.",
  clock: "Your AVADO's clock is wrong, so AVADO can't receive its check-ins. Please contact AVADO support.",
  signature: "AVADO could not confirm that this check-in came from your box. AVADO support will look into it; there is nothing you need to do.",
  slowDown: "AVADO asked this box to check in less often. AVADO Care tries again later.",
  unexpected: "Something went wrong while checking in. AVADO Care tries again in 10 minutes.",
};

export interface CareDeps {
  openWamp(): WampSession;
  fetch: typeof fetch;
  now(): number;
  store: StateStore;
  /** 0..1, for the jitter on every interval. Defaults to Math.random. */
  random?(): number;
}

export interface StatusResponse {
  version: string;
  lastHeartbeat: { at: string | null; ok: boolean; error: string | null };
  /** Why the last heartbeat failed ("outdated", "clock", "offline", ...), null when it worked. */
  heartbeatIssue: HeartbeatIssue | null;
  verdict: Verdict;
  findings: StatusFinding[];
  subscribed: boolean | null;
  /** null unless the backend says whether the owner's alert email is confirmed. */
  emailVerified: boolean | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  checking: boolean;
  /** Which inputs the last check could read ("ok", "failed", "not-installed", ...), for support. */
  sources: Record<string, string>;
  /** A plain message about the checks themselves (not a finding), or null. */
  notice: string | null;
}

export const NOTICES = {
  packagesStale:
    "Your AVADO has not been able to list its apps for more than a day, so AVADO Care can't check them. Restarting your AVADO usually fixes this; if it doesn't, please contact AVADO support.",
} as const;

export function toStatusFindings(check: CheckResult): StatusFinding[] {
  return check.findings.slice(0, 50).map((f) => ({
    id: String(f.id),
    severity: f.severity,
    topic: String(f.topic ?? ""),
    title: String(f.title),
    why: typeof f.why === "string" ? f.why : null,
  }));
}

export function heartbeatIssueOf(e: unknown): HeartbeatIssue {
  if (e instanceof ClockError) return "clock";
  if (e instanceof DappmanagerError) return e.kind === "outdated" ? "outdated" : "dappmanager";
  if (e instanceof BackendError) {
    if (e.status === null || e.status >= 500) return "offline";
    if (e.status === 401) return "signature";
    if (e.status === 429) return "slowDown";
  }
  return "unexpected";
}

/** The DAPPMANAGER cannot sign with the backend's time: the box clock is more than ~10 minutes off. */
export class ClockError extends Error {}

export class CareService {
  private state: CareState;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: number | null = null;
  private lastRunEndedAt = 0;
  private stopped = false;
  private readonly inputs: Inputs;
  private readonly random: () => number;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly deps: CareDeps,
    initialState: CareState,
  ) {
    this.state = initialState;
    this.inputs = new Inputs(deps.now, initialState.sourceOkAt as Partial<Record<SourceName, number>>);
    this.random = deps.random ?? Math.random;
  }

  status(): StatusResponse {
    return {
      version: this.config.version,
      lastHeartbeat: { ...this.state.lastHeartbeat },
      heartbeatIssue: this.state.heartbeatIssue,
      verdict: this.state.lastCheck?.verdict ?? "checking",
      findings: this.state.lastCheck?.findings ?? [],
      subscribed: this.state.subscribed,
      emailVerified: this.state.emailVerified,
      lastCheckAt: this.state.lastCheck?.at ?? null,
      nextCheckAt: this.nextAt === null || this.running !== null ? null : new Date(this.nextAt).toISOString(),
      checking: this.running !== null,
      sources: { ...(this.state.lastCheck?.sources ?? {}) },
      notice: this.state.lastCheck?.sources.packages === "stale" ? NOTICES.packagesStale : null,
    };
  }

  get currentState(): CareState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    // jitter so boxes that rebooted together do not all check in at once
    this.schedule(this.config.firstRunDelayMs + Math.floor(this.random() * 30_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /**
   * "Check now": joins a run in progress or starts one; refuses when the last one ended less
   * than the cooldown ago. Waits at most `waitMs`; `done: false` means it is still running
   * (the page keeps polling /api/status).
   *
   * A freshly started run also refreshes the package list when it is older than
   * CHECK_NOW_PACKAGES_TTL_MS, so a user pressing "Check now" sees current app state (a stopped
   * or newly installed app). A run already in progress keeps whatever TTL it started with;
   * automatic checks keep the hourly cadence.
   */
  async checkNow(waitMs = 60_000): Promise<{ ran: boolean; done: boolean }> {
    if (!this.running && this.deps.now() - this.lastRunEndedAt < this.config.checkNowCooldownMs) return { ran: false, done: true };
    const run = this.running ?? this.runOnce(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([run.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs)))]);
    clearTimeout(timer);
    return { ran: true, done };
  }

  /** One full cycle. Never throws; concurrent callers share the same run. */
  runOnce(forcePackagesRefresh = false): Promise<void> {
    if (this.running) return this.running;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.cycle(forcePackagesRefresh)
      .catch((e: unknown) => {
        this.logger.error(`care cycle failed: ${errorMessage(e)}`);
        return null;
      })
      .then((nextInSec) => {
        this.running = null;
        this.lastRunEndedAt = this.deps.now();
        if (!this.stopped) this.schedule(this.nextInterval(nextInSec));
      });
    this.running = run;
    return run;
  }

  private nextInterval(nextInSec: number | null): number {
    let ms = nextInSec === null ? this.config.intervalMs : Math.min(this.config.maxIntervalMs, Math.max(this.config.minIntervalMs, nextInSec * 1000));
    if (this.state.outdatedDappmanager) ms = Math.max(ms, OUTDATED_INTERVAL_MS);
    // ±60 s on every interval, so boxes spread out again after a backend outage
    return Math.max(this.config.minIntervalMs / 2, ms + Math.round((this.random() * 2 - 1) * 60_000));
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.deps.now() + ms;
    this.timer = setTimeout(() => void this.runOnce(), ms);
    this.timer.unref?.();
  }

  /** @returns the backend's nextInSec, when it sent one */
  private async cycle(forcePackagesRefresh = false): Promise<number | null> {
    const wamp = this.deps.openWamp();
    const { inputs } = this;
    try {
      let check = await runHealthCheck(
        {
          listPackages: () => inputs.installedPackages(() => listPackages(wamp), forcePackagesRefresh ? CHECK_NOW_PACKAGES_TTL_MS : undefined),
          getStats: () => inputs.read("stats", () => getStats(wamp)),
          getParams: () => inputs.read("params", () => getParams(wamp)),
          fetchChainData: () =>
            inputs.read("chainData", async () => {
              const data = await fetchChainData(wamp, this.config.chainDataPushWaitMs);
              if (!data) throw new Error("no chain data arrived");
              return data;
            }),
          fetchStorePackages: (nodeid, pkgs) => inputs.storePackages(() => fetchStorePackages(this.config, nodeid, pkgs, this.deps.fetch)),
          fetchMetrics: () => inputs.metrics(() => fetchMetrics(this.deps.fetch)),
          fetchFeeRecipients: (packages) => {
            const running = packages.filter((p) => p.running && VALIDATOR_CLIENTS.some((c) => c.name === p.name)).map((p) => p.name);
            if (!running.length) return Promise.resolve(null);
            return inputs.feeRecipients(running, () => fetchFeeRecipients(packages, this.deps.fetch));
          },
          updateAges: (updates) => {
            this.state.updateAges = trackUpdateAges(this.state.updateAges, updates, this.deps.now());
            return this.state.updateAges;
          },
          now: this.deps.now,
        },
        this.logger,
      );
      check = carryOverFindings(check, this.state.lastCheck?.findings ?? [], this.carrySources(check));
      this.state.lastCheck = { at: check.at, verdict: check.verdict, findings: toStatusFindings(check), sources: { ...check.sources } };
      const criticals = check.findings.filter((f) => f.severity === "critical").length;
      this.logger.info(`health check: ${check.verdict}, ${check.findings.length} finding(s), ${criticals} critical`);
      return await this.sendHeartbeat(wamp, check);
    } finally {
      wamp.close();
      this.state.sourceOkAt = { ...this.inputs.lastOkTimes() };
      await this.deps.store.save(this.state);
    }
  }

  /**
   * Failed inputs (and single failed Prometheus queries) whose previous findings are kept: only
   * while they worked within the last 24 h.
   */
  private carrySources(check: CheckResult): Set<CarrySource> {
    const out = new Set<CarrySource>();
    for (const source of failedSources(check)) {
      // the last good read is kept in state.json, so this limit holds across restarts
      const lastOk = this.inputs.lastOkAt(source);
      if (lastOk !== null && this.deps.now() - lastOk <= CARRY_MAX_MS) out.add(source);
    }
    return out;
  }

  private fail(at: string, issue: HeartbeatIssue): null {
    this.state.lastHeartbeat = { at, ok: false, error: MESSAGES[issue] };
    this.state.heartbeatIssue = issue;
    return null;
  }

  private async sendHeartbeat(wamp: WampSession, check: CheckResult): Promise<number | null> {
    const now = this.deps.now();
    const at = new Date(now).toISOString();
    // Without a package list there is nothing to report and usually nobody to sign it. A list that
    // is only stale (the DAPPMANAGER answers other calls) still gets a "checking" heartbeat, so the
    // box does not read as offline.
    const staleButUp = check.sources.packages === "stale" && check.sources.stats === "ok";
    if (!check.ready && !staleButUp) return this.fail(at, "dappmanager");

    const dappmanagerVersion = check.snapshot.packages.find((p) => p.name === DAPPMANAGER_PACKAGE)?.version ?? "unknown";
    if (this.state.outdatedDappmanager && this.state.outdatedDappmanager === dappmanagerVersion) return this.fail(at, "outdated");
    const clockUntil = this.state.clockErrorUntil ? Date.parse(this.state.clockErrorUntil) : NaN;
    if (Number.isFinite(clockUntil) && clockUntil > now) return this.fail(at, "clock");
    this.state.clockErrorUntil = null;

    const payload = JSON.stringify(buildHeartbeatPayload(check, this.config.version));
    try {
      const json = await this.signAndPost(wamp, payload, dappmanagerVersion, check.ready || staleButUp);
      const res = parseHeartbeatResponse(json);
      if (!res.ok) throw new BackendError("the heartbeat was not accepted", 200);
      this.state.subscribed = res.subscribed;
      this.state.emailVerified = res.emailVerified;
      this.state.lastHeartbeat = { at, ok: true, error: null };
      this.state.heartbeatIssue = null;
      this.state.lastSuccessAt = at;
      this.logger.info(`heartbeat sent (${res.subscribed ? "Priority Care active" : "not subscribed"})`);
      return res.nextInSec;
    } catch (e) {
      const issue = heartbeatIssueOf(e);
      if (issue === "clock") this.state.clockErrorUntil = new Date(this.deps.now() + BACKOFF_MS).toISOString();
      this.logger.warn(`heartbeat failed: ${errorMessage(e)}`);
      return this.fail(at, issue);
    }
  }

  /**
   * Signs the payload through the DAPPMANAGER (contract A) and posts it (contract B). When the
   * backend refuses the timestamp (401 with its serverTime), re-signs once with the backend's
   * clock and retries once, but only when that time is within 9 minutes of this box's clock
   * (the DAPPMANAGER refuses anything beyond ±10 min): otherwise ClockError, without asking it.
   */
  private async signAndPost(wamp: WampSession, payload: string, dappmanagerVersion: string, readsWorked: boolean): Promise<unknown> {
    const hash = sha256Hex(payload);
    const sign = async (timestamp: number) => {
      try {
        const sig = await signCareRequest(wamp, "care-heartbeat", timestamp, hash);
        this.state.outdatedDappmanager = null;
        return sig;
      } catch (e) {
        let err = e;
        // A DAPPMANAGER without signPrioritySupportRequest at all, while its other calls answer
        if (readsWorked && e instanceof DappmanagerError && e.kind === "unavailable" && /no_such_procedure/.test(e.message)) {
          err = new DappmanagerError("signPrioritySupportRequest: not available on this DAPPMANAGER", "outdated");
        }
        if (err instanceof DappmanagerError && err.kind === "outdated") this.state.outdatedDappmanager = dappmanagerVersion;
        throw err;
      }
    };

    try {
      const sig = await sign(Math.floor(this.deps.now() / 1000));
      return await postSigned(this.config.backendUrl, HEARTBEAT_ROUTE, { ...sig, payload }, this.deps.fetch);
    } catch (e) {
      if (!(e instanceof BackendError) || e.status !== 401 || e.serverTime === null) throw e;
      const skew = Math.abs(e.serverTime - this.deps.now() / 1000);
      if (skew > MAX_CLOCK_SKEW_SEC) throw new ClockError(`the box clock is ${Math.round(skew)} s away from the backend's`);
      this.logger.warn("heartbeat: the backend refused this box's time; retrying once with the backend's clock");
      let sig;
      try {
        sig = await sign(e.serverTime);
      } catch (signError) {
        if (signError instanceof DappmanagerError && signError.kind === "rejected") throw new ClockError(signError.message);
        throw signError;
      }
      return postSigned(this.config.backendUrl, HEARTBEAT_ROUTE, { ...sig, payload }, this.deps.fetch);
    }
  }
}
