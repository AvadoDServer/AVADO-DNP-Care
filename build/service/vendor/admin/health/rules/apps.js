import { getClient, ROLES, PROMETHEUS_PACKAGE } from "health/clients";

const shortName = (name = "") => name.split(".")[0];
export const appTitle = pkg => (pkg && pkg.manifest && pkg.manifest.title) || shortName(pkg && pkg.name);
const isClient = pkg => {
  const c = getClient(pkg.name);
  return Boolean(c && (c.role === ROLES.EXECUTION || c.role === ROLES.CONSENSUS));
};
const logsLink = name => `/packages/${name}?tab=logs`;

export function appStopped({ packages }) {
  return (packages || [])
    // Prometheus gets its own, more specific finding (monitoringStopped, in
    // health/rules/setup.js) so a stopped monitoring package surfaces once,
    // not as a generic "X is stopped" here as well.
    .filter(p => p && !p.isCore && p.name !== PROMETHEUS_PACKAGE && (p.state === "exited" || p.state === "dead"))
    .map(p => ({
      id: `app-stopped:${p.name}`,
      severity: isClient(p) ? "critical" : "warning",
      topic: "sync",
      appId: p.name,
      title: `${appTitle(p)} is stopped`,
      why: isClient(p)
        ? "While it is stopped it does not follow the chain, so your validators miss attestations and rewards."
        : "Anything that depends on it will not work until it runs again.",
      fix: { kind: "action", action: "restartPackage", label: "Start it" },
      secondary: { kind: "link", to: logsLink(p.name), label: "See why in the logs" },
    }));
}

export function appRestarting({ packages }) {
  return (packages || [])
    .filter(p => p && p.state === "restarting")
    .map(p => ({
      id: `app-restarting:${p.name}`,
      severity: "critical",
      topic: "sync",
      appId: p.name,
      title: `${appTitle(p)} keeps restarting`,
      why: "It starts, fails and starts again. The reason is almost always in the last lines of its logs.",
      fix: { kind: "link", to: logsLink(p.name), label: "Open the logs" },
      steps: [
        "Open the logs and look at the last error before the restart.",
        "If it says the disk is full, free space in System → Storage.",
        "If it mentions a setting you changed, switch to Advanced mode (bottom of the sidebar) and undo it in the app's Settings tab.",
        "Still restarting? Download the diagnostics report in Help and send it to support.",
      ],
    }));
}

export function coreAppDown({ packages }) {
  return (packages || [])
    .filter(p => p && p.isCore && p.running === false)
    .map(p => ({
      id: `core-app-down:${p.name}`,
      severity: "critical",
      topic: "core",
      appId: p.name,
      title: `System service ${appTitle(p)} is not running`,
      why: "Your AVADO needs its system services to install, update and reach apps.",
      fix: { kind: "link", to: "/system", label: "Open System" },
    }));
}
