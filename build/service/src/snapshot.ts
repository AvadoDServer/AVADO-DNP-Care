/**
 * Builds the same health snapshot the Admin's HealthProvider builds
 * (DNP_ADMIN/build/src/src/health/HealthProvider.jsx), from the same sources:
 *  - packages: DAPPMANAGER listPackages
 *  - stats: DAPPMANAGER getStats (disk, memory, cpu)
 *  - params: DAPPMANAGER getParams (only the fields the rules read are kept)
 *  - chainData: the DAPPMANAGER chainData topic, parsed like the Admin's parseChainDataMessages
 *  - updates: the store catalogue compared with the installed versions (vendored computeUpdates)
 *  - metrics: Prometheus, only while the monitoring package runs (vendored fetchMetrics)
 * and then runs the vendored rules.
 *
 * Not read (their rules are skipped, not counted as passed): coreUpdate (nothing here checks for
 * a system update) and diskTrend (the disk-full forecast, diskFillingUp).
 */
import { PROMETHEUS_PACKAGE } from "./admin/health/clients.js";
import { runChecksDetailed, verdictOf } from "./admin/health/engine.js";
import { fetchMetrics } from "./admin/health/prometheus.js";
import { ALL_RULES } from "./admin/health/rules/index.js";
import type { ChainDataEntry, Finding, MetricKey, Metrics, PackageInfo, Snapshot, SourceStatus } from "./admin/health/types.js";
import { computeUpdates } from "./admin/services/store/updates.js";
import { errorMessage, type Logger } from "./log.js";

export type Verdict = "ok" | "warning" | "critical" | "checking";

export interface SnapshotSources {
  /** Where each input came from on this run; "failed" inputs are left empty (the Admin does the same). */
  /** "stale": the list could not be refreshed for more than a day, so it is not used. */
  packages: "ok" | "failed" | "stale";
  stats: "ok" | "failed";
  params: "ok" | "failed";
  chainData: "ok" | "failed";
  updates: SourceStatus;
  /** "partial" when some Prometheus queries failed and the others answered (see failedMetricKeys). */
  metrics: SourceStatus;
  /** Validator clients' fee recipients (keymanager); "not-installed" when no validator client runs. */
  feeRecipients: SourceStatus;
}

export interface CheckResult {
  at: string;
  /** false when the installed-packages list could not be read: no verdict is made then. */
  ready: boolean;
  verdict: Verdict;
  findings: Finding[];
  snapshot: Snapshot;
  sources: SnapshotSources;
}

/** Everything the snapshot reads, injectable for tests. */
export interface SnapshotDeps {
  listPackages(): Promise<unknown[]>;
  getStats(): Promise<Record<string, unknown>>;
  getParams(): Promise<Record<string, unknown>>;
  fetchChainData(): Promise<unknown[] | null>;
  fetchStorePackages(nodeid: string, packages: Array<{ name: string; version?: string }>): Promise<unknown[]>;
  fetchMetrics(): Promise<Metrics | null>;
  /** Fee recipients per running validator client (vendored fetchFeeRecipients); null when none runs. */
  fetchFeeRecipients(packages: PackageInfo[]): Promise<Snapshot["feeRecipients"]>;
  /** Records when each pending update was first seen (vendored trackUpdateAges) and returns the ages. */
  updateAges(updates: Snapshot["updates"]): Snapshot["updateAges"];
  now(): number;
}

/** Only what the rules read. Env values (listPackages appends each package's env file) never enter the snapshot. */
export function cleanPackage(raw: unknown): PackageInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name) return null;
  const manifest = p.manifest && typeof p.manifest === "object" ? (p.manifest as Record<string, unknown>) : undefined;
  const out: PackageInfo = {
    name: p.name,
    id: p.name,
    version: typeof p.version === "string" ? p.version : undefined,
    state: typeof p.state === "string" ? p.state : undefined,
    running: typeof p.running === "boolean" ? p.running : undefined,
    isCore: p.isCore === true,
    volumes: Array.isArray(p.volumes)
      ? (p.volumes as unknown[]).map((v) => ({ size: v && typeof v === "object" ? ((v as { size?: string | number }).size ?? undefined) : undefined }))
      : [],
    manifest: manifest
      ? {
          name: typeof manifest.name === "string" ? manifest.name : undefined,
          title: typeof manifest.title === "string" ? manifest.title : undefined,
          version: typeof manifest.version === "string" ? manifest.version : undefined,
          autoupdate: typeof manifest.autoupdate === "boolean" ? manifest.autoupdate : undefined,
        }
      : undefined,
  };
  if (typeof p.autoupdate === "boolean") out.autoupdate = p.autoupdate;
  return out;
}

/** Only the params the rules read: no IPs, no domain. */
export function cleanParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.nodeid === "string") out.nodeid = raw.nodeid;
  for (const key of ["alertToOpenPorts", "upnpAvailable", "noNatLoopback"]) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}

const includes = (s: unknown, part: string) => typeof s === "string" && s.toLowerCase().includes(part.toLowerCase());

/** Port of DNP_ADMIN services/chainData/parsers/parseChainDataMessages.js. */
export function parseChainDataMessage(raw: unknown): ChainDataEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const chain = raw as ChainDataEntry;
  let { name, message, syncing } = chain;
  if (includes(name, "ethchain")) name = "Mainnet";
  if (includes(message, "ECONNREFUSED")) message = "DNP stopped or unreachable (connection refused)";
  if (includes(message, "Invalid JSON RPC response")) message = "DNP stopped or unreachable (invalid response)";
  if (includes(message, "synced #0")) {
    message = "Syncing...";
    syncing = true;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...chain, name, message, syncing })) if (v !== undefined) out[k] = v;
  return out as ChainDataEntry;
}

/**
 * What Care reports (status page, heartbeat, verdict): every finding except the tips an owner can
 * hide on the Admin's Home (`dismissable`, e.g. two-validator-clients). Care has no way to hide
 * them, so it would warn (and email) about them for good.
 */
export function reportable(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => !f.dismissable);
}

/**
 * Which findings come from which Prometheus query (the `needs` predicates in rules/chain.js).
 * missed-attestations also reads the hit count: without it the share of misses (its severity) is wrong.
 */
export const METRIC_FINDINGS: Record<MetricKey, readonly string[]> = {
  headSlot: ["head-behind:"],
  peers: ["low-peers:"],
  attesterMiss: ["missed-attestations:"],
  attesterHit: ["missed-attestations:"],
};

/** The queries that failed in a partial Prometheus read (their key is null); none when there is no read. */
export function failedMetricKeys(metrics: Metrics | null): MetricKey[] {
  if (!metrics) return [];
  return (Object.keys(METRIC_FINDINGS) as MetricKey[]).filter((key) => metrics[key] == null);
}

export async function runHealthCheck(deps: SnapshotDeps, logger: Logger): Promise<CheckResult> {
  const sources: SnapshotSources = { packages: "failed", stats: "failed", params: "failed", chainData: "failed", updates: "failed", metrics: "not-installed", feeRecipients: "not-installed" };

  let packages: PackageInfo[] = [];
  try {
    packages = (await deps.listPackages()).map(cleanPackage).filter((p): p is PackageInfo => p !== null);
    sources.packages = "ok";
  } catch (e) {
    if (e instanceof Error && e.name === "StalePackagesError") sources.packages = "stale";
    logger.warn(`health check: cannot list packages: ${errorMessage(e)}`);
  }

  let stats: Record<string, unknown> = {};
  try {
    const s = await deps.getStats();
    stats = { cpu: s.cpu, memory: s.memory, disk: s.disk, diskTotal: s.diskTotal, diskUsed: s.diskUsed };
    sources.stats = "ok";
  } catch (e) {
    logger.warn(`health check: cannot read stats: ${errorMessage(e)}`);
  }

  let params: Record<string, unknown> = {};
  try {
    params = cleanParams(await deps.getParams());
    sources.params = "ok";
  } catch (e) {
    logger.warn(`health check: cannot read params: ${errorMessage(e)}`);
  }

  let chainData: ChainDataEntry[] = [];
  try {
    const raw = await deps.fetchChainData();
    if (raw) {
      chainData = raw.map(parseChainDataMessage).filter((c): c is ChainDataEntry => c !== null);
      sources.chainData = "ok";
    } else {
      logger.warn("health check: no chain data arrived");
    }
  } catch (e) {
    logger.warn(`health check: cannot read chain data: ${errorMessage(e)}`);
  }

  // Store catalogue: like the Admin, only with a node id; "failed" feeds the storeUnreachable rule.
  let updates: Snapshot["updates"] = null;
  if (typeof params.nodeid === "string" && sources.packages === "ok") {
    try {
      const storePackages = await deps.fetchStorePackages(
        params.nodeid,
        packages.map((p) => ({ name: p.name, version: p.version })),
      );
      updates = computeUpdates(storePackages, packages as Array<{ name: string; version?: string }>);
      sources.updates = "ok";
    } catch (e) {
      logger.warn(`health check: cannot reach the store: ${errorMessage(e)}`);
    }
  }

  // Prometheus: only while the monitoring package runs, like the Admin.
  let metrics: Metrics | null = null;
  if (packages.some((p) => p.name === PROMETHEUS_PACKAGE && p.running)) {
    metrics = await deps.fetchMetrics().catch(() => null);
    sources.metrics = !metrics ? "failed" : failedMetricKeys(metrics).length ? "partial" : "ok";
  }

  // Fee recipients: only for running validator clients; a client that can't be read is left out.
  let feeRecipients: Snapshot["feeRecipients"] = null;
  if (sources.packages === "ok") {
    try {
      feeRecipients = await deps.fetchFeeRecipients(packages);
      sources.feeRecipients = feeRecipients ? "ok" : "not-installed";
    } catch (e) {
      sources.feeRecipients = "failed";
      logger.warn(`health check: cannot read fee recipients: ${errorMessage(e)}`);
    }
  }

  const updateAges = deps.updateAges(updates);

  const now = deps.now();
  const snapshot: Snapshot = {
    packages,
    stats,
    params,
    diagnoses: [],
    chainData,
    updates,
    // Nothing here checks for a system update: null skips coreUpdateAvailable (like the Admin
    // while its own core-update check is off) instead of counting it as a check that passed.
    coreUpdate: null,
    metrics,
    // Not read: the disk-full forecast (diskFillingUp) is skipped and disk-high has no forecast.
    diskTrend: null,
    feeRecipients,
    updateAges,
    sources: { updates: sources.updates, metrics: sources.metrics },
    now,
  };

  // No verdict without the package list: every rule would find nothing and read as "all good".
  const ready = sources.packages === "ok" && packages.length > 0;
  const findings = ready ? reportable(runChecksDetailed(snapshot, ALL_RULES).findings) : [];
  return {
    at: new Date(now).toISOString(),
    ready,
    verdict: ready ? verdictOf(findings).level : "checking",
    findings,
    snapshot,
    sources,
  };
}

/**
 * Which findings come from which input. When an input fails for one check, its rules find
 * nothing (no data), which would read as "cleared" and re-alert when it comes back.
 * One Prometheus query that fails while the others answer is its own input (METRIC_FINDINGS).
 */
export const SOURCE_FINDINGS: Record<"stats" | "params" | "chainData" | "updates" | "metrics" | "feeRecipients", readonly string[]> = {
  stats: ["disk-high"],
  params: ["ports-closed", "no-upnp", "no-nat-loopback"],
  chainData: ["chain-syncing:", "chain-error:"],
  updates: ["updates-available", "update-blocked:"],
  metrics: ["head-behind:", "low-peers:", "missed-attestations:"],
  feeRecipients: ["fee-recipient-missing:"],
};

/** An input that failed in a check: a whole one, or one Prometheus query while the others answered ("metrics.headSlot"). */
export type CarrySource = keyof typeof SOURCE_FINDINGS | `metrics.${MetricKey}`;

const prefixesOf = (source: CarrySource): readonly string[] =>
  source.startsWith("metrics.") ? METRIC_FINDINGS[source.slice("metrics.".length) as MetricKey] : SOURCE_FINDINGS[source as keyof typeof SOURCE_FINDINGS];

export function findingFromSource(id: string, source: CarrySource): boolean {
  return prefixesOf(source).some((p) => (p.endsWith(":") ? id.startsWith(p) : id === p));
}

/** The inputs that failed in this check, and each Prometheus query that failed while the others answered. */
export function failedSources(check: CheckResult): CarrySource[] {
  const inputs = (Object.keys(SOURCE_FINDINGS) as Array<keyof typeof SOURCE_FINDINGS>).filter((s) => check.sources[s] === "failed");
  return [...inputs, ...failedMetricKeys(check.snapshot.metrics).map((key): CarrySource => `metrics.${key}`)];
}

export interface PreviousFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  topic: string;
  title: string;
  why: string | null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/**
 * For each input that failed in this check (and is listed in `carry`), keeps the previous
 * check's findings from that input instead of this check's, and recomputes the verdict.
 * This check's own findings from every failed input (`failed`, whether or not it is carried) are
 * dropped: a whole input that failed gives none, but a rule can still run on a partial Prometheus
 * read (missed-attestations without the hit count reads every attestation as missed) and would
 * raise or escalate a finding on half the data, also when there is nothing (left) to carry.
 * Carried findings are marked `carried: true`.
 */
export function carryOverFindings(
  check: CheckResult,
  previous: readonly PreviousFinding[],
  carry: ReadonlySet<CarrySource>,
  failed: ReadonlySet<CarrySource> = new Set(failedSources(check)),
): CheckResult {
  if (!check.ready || (carry.size === 0 && failed.size === 0)) return check;
  const from = (sources: ReadonlySet<CarrySource>, id: string) => [...sources].some((source) => findingFromSource(id, source));
  const kept = check.findings.filter((f) => !from(failed, String(f.id)) && !from(carry, String(f.id)));
  const have = new Set(kept.map((f) => f.id));
  const added: Finding[] = [];
  for (const p of previous) {
    if (!from(carry, p.id) || have.has(p.id)) continue;
    have.add(p.id);
    added.push({ id: p.id, severity: p.severity, topic: p.topic, title: p.title, ...(p.why ? { why: p.why } : {}), carried: true });
  }
  if (!added.length && kept.length === check.findings.length) return check;
  const findings = [...kept, ...added].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  return { ...check, findings, verdict: verdictOf(findings).level };
}

export { fetchMetrics };
