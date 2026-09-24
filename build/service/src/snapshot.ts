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
 */
import { PROMETHEUS_PACKAGE } from "./admin/health/clients.js";
import { runChecksDetailed, verdictOf } from "./admin/health/engine.js";
import { fetchMetrics } from "./admin/health/prometheus.js";
import { ALL_RULES } from "./admin/health/rules/index.js";
import type { ChainDataEntry, Finding, Metrics, PackageInfo, Snapshot, SourceStatus } from "./admin/health/types.js";
import { computeUpdates } from "./admin/services/store/updates.js";
import { errorMessage, type Logger } from "./log.js";

export type Verdict = "ok" | "warning" | "critical" | "checking";

export interface SnapshotSources {
  /** Where each input came from on this run; "failed" inputs are left empty (the Admin does the same). */
  packages: "ok" | "failed";
  stats: "ok" | "failed";
  params: "ok" | "failed";
  chainData: "ok" | "failed";
  updates: SourceStatus;
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

export async function runHealthCheck(deps: SnapshotDeps, logger: Logger): Promise<CheckResult> {
  const sources: SnapshotSources = { packages: "failed", stats: "failed", params: "failed", chainData: "failed", updates: "failed", metrics: "not-installed", feeRecipients: "not-installed" };

  let packages: PackageInfo[] = [];
  try {
    packages = (await deps.listPackages()).map(cleanPackage).filter((p): p is PackageInfo => p !== null);
    sources.packages = "ok";
  } catch (e) {
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
    sources.metrics = metrics ? "ok" : "failed";
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
    coreUpdate: { available: false },
    metrics,
    feeRecipients,
    updateAges,
    sources: { updates: sources.updates, metrics: sources.metrics },
    now,
  };

  // No verdict without the package list: every rule would find nothing and read as "all good".
  const ready = sources.packages === "ok" && packages.length > 0;
  const findings = ready ? runChecksDetailed(snapshot, ALL_RULES).findings : [];
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
 */
export const SOURCE_FINDINGS: Record<"stats" | "params" | "chainData" | "updates" | "metrics" | "feeRecipients", readonly string[]> = {
  stats: ["disk-high"],
  params: ["ports-closed", "no-upnp", "no-nat-loopback"],
  chainData: ["chain-syncing:", "chain-error:"],
  updates: ["updates-available", "update-blocked:"],
  metrics: ["head-behind:", "low-peers:", "missed-attestations:"],
  feeRecipients: ["fee-recipient-missing:"],
};

export function findingFromSource(id: string, source: keyof typeof SOURCE_FINDINGS): boolean {
  return SOURCE_FINDINGS[source].some((p) => (p.endsWith(":") ? id.startsWith(p) : id === p));
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
 * check's findings from that input instead of dropping them, and recomputes the verdict.
 * Carried findings are marked `carried: true`.
 */
export function carryOverFindings(check: CheckResult, previous: readonly PreviousFinding[], carry: ReadonlySet<keyof typeof SOURCE_FINDINGS>): CheckResult {
  if (!check.ready || carry.size === 0 || previous.length === 0) return check;
  const have = new Set(check.findings.map((f) => f.id));
  const added: Finding[] = [];
  for (const source of carry) {
    for (const p of previous) {
      if (!findingFromSource(p.id, source) || have.has(p.id)) continue;
      have.add(p.id);
      added.push({ id: p.id, severity: p.severity, topic: p.topic, title: p.title, ...(p.why ? { why: p.why } : {}), carried: true });
    }
  }
  if (!added.length) return check;
  const findings = [...check.findings, ...added].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  return { ...check, findings, verdict: verdictOf(findings).level };
}

export { fetchMetrics };
