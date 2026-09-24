/**
 * The signed heartbeat (contract B, POST <backend>/api/care/heartbeat, action care-heartbeat).
 *
 * The payload is the ONLY data that leaves the box: package names and versions, disk %,
 * the verdict, and the ids and titles of critical/warning findings. No keys, IPs, peers,
 * wallet or validator data. buildHeartbeatPayload builds it from scratch, field by field,
 * so nothing else from the snapshot can slip in.
 */
import { createHash } from "node:crypto";
import { parsePercent } from "./admin/health/rules/storage.js";
import type { CheckResult, Verdict } from "./snapshot.js";

export interface HeartbeatPayload {
  v: 1;
  verdict: Verdict;
  disk: { usedPct: number } | null;
  packages: Array<{ name: string; version: string }>;
  findings: Array<{ id: string; level: "critical" | "warning"; title: string }>;
  care: { version: string };
}

export const HEARTBEAT_KEYS = ["v", "verdict", "disk", "packages", "findings", "care"] as const;

const MAX_PACKAGES = 200;
const MAX_FINDINGS = 50;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The backend's limits (priority-care routes/care.js): ids ≤ 120, names ≤ 200, versions ≤ 100, titles ≤ 300. */
export const LIMITS = { id: 120, name: 120, version: 80, title: 200 } as const;

export function buildHeartbeatPayload(check: CheckResult, careVersion: string): HeartbeatPayload {
  const pct = parsePercent(check.snapshot.stats.disk);
  const disk = pct === null || !Number.isFinite(pct) ? null : { usedPct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)) };
  const packages = check.snapshot.packages
    .map((p) => ({ name: clip(String(p.name), LIMITS.name), version: clip(typeof p.version === "string" ? p.version : "", LIMITS.version) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PACKAGES);
  const findings = check.findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .slice(0, MAX_FINDINGS)
    .map((f) => ({ id: clip(String(f.id), LIMITS.id), level: f.severity as "critical" | "warning", title: clip(String(f.title), LIMITS.title) }));
  return { v: 1, verdict: check.verdict, disk, packages, findings, care: { version: careVersion } };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SignedBody {
  nodeId: string;
  timestamp: number;
  signature: string;
  /** The exact JSON string that was hashed and signed. */
  payload: string;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The backend's clock (unix seconds), sent with a 401 when the timestamp was outside its window. */
    readonly serverTime: number | null = null,
  ) {
    super(message);
  }
}

export interface HeartbeatResponse {
  ok: boolean;
  subscribed: boolean;
  nextInSec: number | null;
  /** Optional (not in contract B yet): whether the owner's alert email is confirmed. */
  emailVerified: boolean | null;
}

/** POSTs a signed body to the backend. Throws BackendError with the backend's plain message. */
export async function postSigned(
  backendUrl: string,
  route: string,
  body: SignedBody,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${backendUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new BackendError("could not reach the AVADO service", null);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    const st = json ? (json as { serverTime?: unknown }).serverTime : undefined;
    const serverTime = typeof st === "number" && Number.isInteger(st) && st > 0 ? st : null;
    throw new BackendError(msg.slice(0, 300), res.status, serverTime);
  }
  return json;
}

export function parseHeartbeatResponse(json: unknown): HeartbeatResponse {
  const r = (json ?? {}) as Record<string, unknown>;
  return {
    ok: r.ok === true,
    subscribed: r.subscribed === true,
    nextInSec: typeof r.nextInSec === "number" && Number.isFinite(r.nextInSec) ? r.nextInSec : null,
    emailVerified: typeof r.emailVerified === "boolean" ? r.emailVerified : null,
  };
}
