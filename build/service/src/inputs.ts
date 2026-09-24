/**
 * How often each input of the health snapshot is read, and what happens when one keeps failing.
 *
 *  - packages (DAPPMANAGER listPackages, which runs `docker system df -v` on the box): at start,
 *    then at most once an hour. A failed refresh keeps the last list.
 *  - store catalogue (rpc.ava.do + IPFS): at most once an hour.
 *  - fee recipients (each validator client's keymanager, one request per key): at most once an
 *    hour. A client that could be read before but not now keeps its last result for up to 24 h.
 *  - everything else (getStats for disk %, getParams, chainData, Prometheus): every check.
 *  - An input whose call was answered with an error (or whose HTTP request failed) 3 times in a
 *    row is left alone for 6 hours. A router that cannot be reached at all does not count: that
 *    costs no DAPPMANAGER work and ends as soon as the DAPPMANAGER is back.
 */
import { WampError } from "./wamp.js";
import { DappmanagerError } from "./dappmanager.js";

export interface ClientFeeRecipients {
  validators: number;
  checked: number;
  missing: number;
}
export type FeeRecipients = Record<string, ClientFeeRecipients>;

export type SourceName = "packages" | "stats" | "params" | "chainData" | "updates" | "metrics" | "feeRecipients";

export const PACKAGES_TTL_MS = 60 * 60 * 1000;
export const STORE_TTL_MS = 60 * 60 * 1000;
export const FEE_RECIPIENTS_TTL_MS = 60 * 60 * 1000;
export const FEE_RECIPIENTS_KEEP_MS = 24 * 60 * 60 * 1000;
export const FAILURES_BEFORE_BACKOFF = 3;
export const BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Thrown instead of calling an input that is backing off. */
export class SkippedError extends Error {}

/** The package list could not be refreshed for more than PACKAGES_STALE_MS: the cached one is too old to use. */
export class StalePackagesError extends Error {
  override readonly name = "StalePackagesError";
}

export const PACKAGES_STALE_MS = 24 * 60 * 60 * 1000;

interface Tracker {
  failures: number;
  retryAt: number;
  lastOkAt: number | null;
}

function isUnreachable(e: unknown): boolean {
  return (e instanceof WampError && e.kind !== "rejected") || (e instanceof DappmanagerError && e.kind === "unavailable");
}

export class Inputs {
  private readonly trackers = new Map<SourceName, Tracker>();
  private packages: { at: number; value: unknown[] } | null = null;
  private store: { at: number; value: unknown[] } | null = null;
  private fee: { at: number; key: string; value: FeeRecipients | null } | null = null;
  private readonly feeLastGood = new Map<string, { at: number; value: ClientFeeRecipients }>();

  /** `lastOk`: each input's last good read (ms), from the state volume, so the 24 h limits survive restarts. */
  constructor(
    private readonly now: () => number,
    lastOk: Partial<Record<SourceName, number>> = {},
  ) {
    for (const [name, at] of Object.entries(lastOk)) {
      if (typeof at === "number" && Number.isFinite(at)) this.tracker(name as SourceName).lastOkAt = at;
    }
  }

  /** Each input's last good read (ms), to persist. */
  lastOkTimes(): Partial<Record<SourceName, number>> {
    const out: Partial<Record<SourceName, number>> = {};
    for (const [name, t] of this.trackers) if (t.lastOkAt !== null) out[name] = t.lastOkAt;
    return out;
  }

  private tracker(name: SourceName): Tracker {
    let t = this.trackers.get(name);
    if (!t) {
      t = { failures: 0, retryAt: 0, lastOkAt: null };
      this.trackers.set(name, t);
    }
    return t;
  }

  /** Calls `fn` unless the input is backing off; records the outcome. */
  async read<T>(name: SourceName, fn: () => Promise<T>): Promise<T> {
    const t = this.tracker(name);
    const now = this.now();
    if (t.retryAt > now) throw new SkippedError(`${name}: paused after repeated failures`);
    try {
      const value = await fn();
      t.failures = 0;
      t.retryAt = 0;
      t.lastOkAt = this.now();
      return value;
    } catch (e) {
      if (!isUnreachable(e)) {
        t.failures++;
        if (t.failures >= FAILURES_BEFORE_BACKOFF) t.retryAt = this.now() + BACKOFF_MS;
      }
      throw e;
    }
  }

  /** The installed packages: fresh when older than an hour (or `force`), else the cached list. */
  async installedPackages(fetch: () => Promise<unknown[]>): Promise<unknown[]> {
    const cached = this.packages;
    if (cached && this.now() - cached.at < PACKAGES_TTL_MS) return cached.value;
    try {
      const value = await this.read("packages", fetch);
      this.packages = { at: this.now(), value };
      return value;
    } catch (e) {
      // keep the last list rather than knowing nothing, but not for more than a day
      const lastOk = this.lastOkAt("packages");
      if (lastOk !== null && this.now() - lastOk > PACKAGES_STALE_MS) {
        throw new StalePackagesError(`the package list could not be read for ${Math.round((this.now() - lastOk) / 3_600_000)} h`);
      }
      if (cached) return cached.value;
      throw e;
    }
  }

  /** The store catalogue, at most once an hour. */
  async storePackages(fetch: () => Promise<unknown[]>): Promise<unknown[]> {
    const cached = this.store;
    if (cached && this.now() - cached.at < STORE_TTL_MS) return cached.value;
    const value = await this.read("updates", fetch);
    this.store = { at: this.now(), value };
    return value;
  }

  /**
   * Fee recipients of the running validator clients (`running`: their package names), at most
   * hourly (sooner when the set of running clients changes). A running client missing from a
   * fresh read keeps its last good result for up to 24 h, so one failed read never "clears"
   * a finding.
   */
  async feeRecipients(running: readonly string[], fetch: () => Promise<FeeRecipients | null>): Promise<FeeRecipients | null> {
    const key = [...running].sort().join("|");
    const now = this.now();
    if (this.fee && this.fee.key === key && now - this.fee.at < FEE_RECIPIENTS_TTL_MS) return this.fee.value;
    // null while clients run means none could be read: a failure (back-off, carry-over), not "nothing wrong"
    let value: FeeRecipients | null = await this.read("feeRecipients", async () => {
      const v = await fetch();
      if (!v) throw new Error("no validator client could be read");
      return v;
    });
    if (value) {
      value = { ...value };
      for (const name of running) {
        const fresh = value[name];
        if (fresh) this.feeLastGood.set(name, { at: now, value: fresh });
        else {
          const last = this.feeLastGood.get(name);
          if (last && now - last.at <= FEE_RECIPIENTS_KEEP_MS) value[name] = last.value;
        }
      }
    }
    this.fee = { at: now, key, value };
    return value;
  }

  /** When the input last worked (ms), or null. */
  lastOkAt(name: SourceName): number | null {
    return this.trackers.get(name)?.lastOkAt ?? null;
  }

  isBackingOff(name: SourceName): boolean {
    return (this.trackers.get(name)?.retryAt ?? 0) > this.now();
  }
}
