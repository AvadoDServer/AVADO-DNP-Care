export const SEVERITIES = ["critical", "warning", "info"];
export const TOPICS = ["setup", "sync", "attestations", "updates", "access", "storage", "core"];

const rank = (list, value) => {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i;
};

/**
 * Run every rule over the snapshot. A rule returns a finding, an array of
 * findings, or null. One failing rule must never hide the others.
 *
 * A rule can set a static `rule.needs = "metrics"` to declare that it
 * cannot evaluate anything meaningful without `snapshot.metrics` (it would
 * otherwise just return `[]`/null and get counted as "passed" — a check
 * that never actually ran). Such a rule is skipped entirely, and doesn't
 * count towards `total`, whenever `snapshot.metrics` is null.
 *
 * @returns {{ findings: array, passed: number, total: number }}
 *   `passed` counts rules that ran and returned null or an empty array
 *   (i.e. the check ran and found nothing wrong). A rule that throws counts
 *   towards neither `passed` nor a finding — its check could not be
 *   evaluated. `total` is `rules.length` minus any metrics-dependent rules
 *   skipped because metrics are unavailable.
 */
export function runChecksDetailed(snapshot, rules) {
  const findings = [];
  let passed = 0;
  let total = 0;
  for (const rule of rules) {
    if (rule.needs === "metrics" && snapshot.metrics == null) continue;
    total++;
    try {
      const out = rule(snapshot);
      if (Array.isArray(out)) {
        const clean = out.filter(Boolean);
        if (clean.length) findings.push(...clean);
        else passed++;
      } else if (out) {
        findings.push(out);
      } else {
        passed++;
      }
    } catch (e) {
      console.error(`Health rule ${rule.name || "(anonymous)"} failed`, e);
    }
  }
  const sorted = findings.sort(
    (a, b) =>
      rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) ||
      rank(TOPICS, a.topic) - rank(TOPICS, b.topic) ||
      String(a.title).localeCompare(String(b.title))
  );
  return { findings: sorted, passed, total };
}

/** Back-compat wrapper: just the sorted findings array. */
export function runChecks(snapshot, rules) {
  return runChecksDetailed(snapshot, rules).findings;
}

export function verdictOf(findings) {
  if (findings.some(f => f.severity === "critical")) return { level: "critical", label: "Action required" };
  if (findings.some(f => f.severity === "warning")) return { level: "warning", label: "Needs attention" };
  return { level: "ok", label: "All good" };
}
