/**
 * The last check and heartbeat, kept on the package volume (/data/state.json) so the status
 * page shows them right after a restart. Nothing secret is stored here.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "./admin/health/types.js";
import { errorMessage, type Logger } from "./log.js";
import type { Verdict } from "./snapshot.js";

export type HeartbeatIssue = "outdated" | "clock" | "offline" | "dappmanager" | "signature" | "slowDown" | "unexpected";
const ISSUES = new Set(["outdated", "clock", "offline", "dappmanager", "signature", "slowDown", "unexpected"]);

export interface StatusFinding {
  id: string;
  severity: Severity;
  topic: string;
  title: string;
  why: string | null;
}

export interface CareState {
  lastCheck: { at: string; verdict: Verdict; findings: StatusFinding[]; sources: Record<string, string> } | null;
  lastHeartbeat: { at: string | null; ok: boolean; error: string | null };
  /** Why the last heartbeat failed, as a code for the status page; null when it worked. */
  heartbeatIssue: HeartbeatIssue | null;
  /** From the backend's heartbeat reply, when it says whether the owner's alert email is confirmed. */
  emailVerified: boolean | null;
  /** While set (ISO time), the box clock is known to be wrong: no signing until then. */
  clockErrorUntil: string | null;
  /** First-seen time (ms) of each pending update, for the 48 h "update blocked" rule. */
  updateAges: Record<string, number> | null;
  /** When the backend last accepted a heartbeat. */
  lastSuccessAt: string | null;
  /** From the last accepted heartbeat; null until the backend has answered once. */
  subscribed: boolean | null;
  /**
   * The DAPPMANAGER version that could not sign care requests. Signing is not retried
   * (and does not fill the Admin's activity log with errors) until the DAPPMANAGER changes.
   */
  outdatedDappmanager: string | null;
}

export function emptyState(): CareState {
  return {
    lastCheck: null,
    lastHeartbeat: { at: null, ok: false, error: null },
    heartbeatIssue: null,
    emailVerified: null,
    clockErrorUntil: null,
    updateAges: null,
    lastSuccessAt: null,
    subscribed: null,
    outdatedDappmanager: null,
  };
}

const VERDICTS = new Set(["ok", "warning", "critical", "checking"]);
const SEVERITIES = new Set(["critical", "warning", "info"]);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Accepts only well-formed fields from disk; anything else falls back to the empty state. */
export function parseState(raw: unknown): CareState {
  const s = emptyState();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  const lc = r.lastCheck as Record<string, unknown> | null | undefined;
  if (lc && typeof lc === "object" && str(lc.at) && VERDICTS.has(lc.verdict as string) && Array.isArray(lc.findings)) {
    s.lastCheck = {
      at: lc.at as string,
      verdict: lc.verdict as Verdict,
      findings: (lc.findings as unknown[])
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .filter((f) => str(f.id) && str(f.title) && SEVERITIES.has(f.severity as string))
        .map((f) => ({ id: f.id as string, severity: f.severity as Severity, topic: str(f.topic) ?? "", title: f.title as string, why: str(f.why) })),
      sources: Object.fromEntries(
        Object.entries(lc.sources && typeof lc.sources === "object" ? (lc.sources as Record<string, unknown>) : {}).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
    };
  }
  const hb = r.lastHeartbeat as Record<string, unknown> | undefined;
  if (hb && typeof hb === "object") {
    s.lastHeartbeat = { at: str(hb.at), ok: hb.ok === true, error: str(hb.error) };
  }
  s.heartbeatIssue = ISSUES.has(r.heartbeatIssue as string) ? (r.heartbeatIssue as HeartbeatIssue) : null;
  s.emailVerified = typeof r.emailVerified === "boolean" ? r.emailVerified : null;
  s.clockErrorUntil = str(r.clockErrorUntil);
  if (r.updateAges && typeof r.updateAges === "object" && !Array.isArray(r.updateAges)) {
    s.updateAges = Object.fromEntries(
      Object.entries(r.updateAges as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])),
    );
  }
  s.lastSuccessAt = str(r.lastSuccessAt);
  s.subscribed = typeof r.subscribed === "boolean" ? r.subscribed : null;
  s.outdatedDappmanager = str(r.outdatedDappmanager);
  return s;
}

export class StateStore {
  private readonly file: string;
  private warned = false;

  constructor(
    dir: string,
    private readonly logger: Logger,
  ) {
    this.file = path.join(dir, "state.json");
  }

  async load(): Promise<CareState> {
    try {
      return parseState(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return emptyState();
    }
  }

  async save(state: CareState): Promise<void> {
    const tmp = `${this.file}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (e) {
      if (!this.warned) this.logger.warn(`cannot save state (kept in memory only): ${errorMessage(e)}`);
      this.warned = true;
    }
  }
}
