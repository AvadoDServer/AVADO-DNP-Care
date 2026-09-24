import { appTitle } from "./apps";

export function parsePercent(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const m = value.match(/(\d+(?:\.\d+)?)\s*%?/);
  return m ? Number(m[1]) : null;
}

// Docker (`docker system df -v`, via DAPPMANAGER's parseDockerSystemDf) reports
// volume sizes as human strings in decimal (1000-based) units, e.g. "27.94GB",
// "1.572GB", "22.34MB", "17.3kB", "63B", "0B" — never raw bytes. Units are
// matched case-insensitively; a bare number (already bytes) passes through
// unchanged; anything unparseable is 0.
const SIZE_UNIT_MULTIPLIERS = {
  "": 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

export function parseDockerSize(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = SIZE_UNIT_MULTIPLIERS[m[2].toLowerCase()];
  return Number.isFinite(n) && mult !== undefined ? n * mult : 0;
}

const SIZE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/**
 * The inverse of parseDockerSize: format a byte count using the same
 * decimal (1000-based) units docker itself reports, so a size shown in the
 * UI doesn't drift from "docker system df -v" (e.g. its "27.94GB" becomes
 * "27.9 GB" here — not `humanFileSize`'s binary/1024-based "26.0 GB", a
 * different number under the same "GB" label).
 */
export function formatDockerSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), SIZE_UNITS.length - 1);
  const value = n / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${SIZE_UNITS[i]}`;
}

export const appDiskUse = pkg =>
  ((pkg && pkg.volumes) || []).reduce((sum, v) => sum + parseDockerSize(v && v.size), 0);

export function diskHigh({ stats, packages }) {
  const pct = parsePercent(stats && stats.disk);
  if (pct === null || pct < 80) return null;
  const biggest = [...(packages || [])]
    .map(p => ({ p, size: appDiskUse(p) }))
    .filter(x => x.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, 2)
    .map(x => appTitle(x.p));
  return {
    id: "disk-high",
    severity: pct >= 90 ? "critical" : "warning",
    topic: "storage",
    title: `Your disk is ${Math.round(pct)}% full`,
    why:
      (pct >= 90
        ? "When the disk is full your clients stop and your validators go offline. "
        : "Clients keep growing; plan some space now before it becomes urgent. ") +
      (biggest.length ? `Most space is used by ${biggest.join(" and ")}.` : ""),
    fix: { kind: "link", to: "/system/storage", label: "Free up space" },
  };
}
