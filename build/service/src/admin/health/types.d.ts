// Types for the vendored AVADO Admin health rules. The JavaScript is in vendor/admin (byte-for-byte
// copies of DNP_ADMIN) and is emitted next to the compiled service by scripts/vendor-build.mjs.
/** Shapes shared by the vendored Admin health modules (see DNP_ADMIN/build/src/src/health). */
export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  topic: string;
  title: string;
  why?: string;
  detail?: string;
  appId?: string;
  dismissable?: boolean;
  [key: string]: unknown;
}

export interface MetricSample {
  client: string;
  network: string;
  value: number;
}

export interface Metrics {
  headSlot: MetricSample[];
  peers: MetricSample[];
  attesterMiss: MetricSample[];
  attesterHit: MetricSample[];
}

export interface ChainDataEntry {
  name: string;
  syncing?: boolean;
  error?: boolean;
  message?: string;
  progress?: number;
  [key: string]: unknown;
}

export interface PackageInfo {
  name: string;
  version?: string;
  state?: string;
  running?: boolean;
  isCore?: boolean;
  autoupdate?: boolean;
  volumes?: Array<{ size?: string | number; [key: string]: unknown }>;
  manifest?: { title?: string; version?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type SourceStatus = "ok" | "failed" | "loading" | "not-installed";

/** The snapshot the Admin's HealthProvider builds and every rule reads. */
export interface Snapshot {
  packages: PackageInfo[];
  stats: Record<string, unknown>;
  params: Record<string, unknown>;
  diagnoses: unknown[];
  chainData: ChainDataEntry[];
  updates: Record<string, { from: string; to: string; hash?: string }> | null;
  coreUpdate: { available: boolean };
  metrics: Metrics | null;
  sources: { updates: SourceStatus; metrics: SourceStatus; [key: string]: unknown };
  now: number;
}

export type Rule = ((snapshot: Snapshot) => Finding | Finding[] | null) & { needs?: "metrics" };
