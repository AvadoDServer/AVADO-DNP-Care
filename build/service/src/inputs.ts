/**
 * How often each input of the health snapshot is read, and what happens when one keeps failing.
 *
 *  - packages (DAPPMANAGER listPackages, which runs `docker system df -v` on the box): at start,
 *    then at most once an hour. A failed refresh keeps the last list.
 *  - store catalogue (rpc.ava.do + IPFS): at most once an hour.
 *  - everything else (getStats for disk %, getParams, chainData, Prometheus): every check.
 *  - An input whose call was answered with an error (or whose HTTP request failed) 3 times in a
 *    row is left alone for 6 hours. A router that cannot be reached at all does not count: that
 *    costs no DAPPMANAGER work and ends as soon as the DAPPMANAGER is back.
 */
import { WampError } from "./wamp.js";
import { DappmanagerError } from "./dappmanager.js";

export type SourceName = "packages" | "stats" | "params" | "chainData" | "updates" | "metrics";

export const PACKAGES_TTL_MS = 60 * 60 * 1000;
export const STORE_TTL_MS = 60 * 60 * 1000;
export const FAILURES_BEFORE_BACKOFF = 3;
export const BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Thrown instead of calling an input that is backing off. */
export class SkippedError extends Error {}

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

  constructor(private readonly now: () => number) {}

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
      if (cached) return cached.value; // keep the last list rather than knowing nothing
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

  /** When the input last worked (ms), or null. */
  lastOkAt(name: SourceName): number | null {
    return this.trackers.get(name)?.lastOkAt ?? null;
  }

  isBackingOff(name: SourceName): boolean {
    return (this.trackers.get(name)?.retryAt ?? 0) > this.now();
  }
}
