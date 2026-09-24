import { getClient, ROLES } from "health/clients";
import { appTitle } from "./apps";

export function updatesAvailable({ updates }) {
  const n = Object.keys(updates || {}).length;
  if (!n) return null;
  return {
    id: "updates-available",
    severity: "warning",
    topic: "updates",
    title: n === 1 ? "1 app update is available" : `${n} app updates are available`,
    why: "Updates fix bugs and keep your clients compatible with network upgrades. Clients that fall behind a hard fork stop following the chain.",
    fix: { kind: "link", to: "/system/updates", label: "Review updates" },
  };
}

export function coreUpdateAvailable({ coreUpdate }) {
  if (!coreUpdate || !coreUpdate.available) return null;
  return {
    id: "core-update-available",
    severity: "warning",
    topic: "updates",
    title: "An AVADO system update is available",
    why: "System updates improve how your AVADO installs, updates and monitors your apps.",
    fix: { kind: "link", to: "/system/updates", label: "Review the update" },
  };
}

export function autoupdateOff({ packages }) {
  return (packages || [])
    .filter(p => p && p.autoupdate === false)
    .filter(p => {
      const c = getClient(p.name);
      return c && (c.role === ROLES.EXECUTION || c.role === ROLES.CONSENSUS);
    })
    .map(p => ({
      id: `autoupdate-off:${p.name}`,
      severity: "info",
      topic: "updates",
      appId: p.name,
      title: `Automatic updates are off for ${appTitle(p)}`,
      why: "Clients need updates before network upgrades. With automatic updates off you have to install them yourself in time.",
      fix: { kind: "link", to: "/packages", label: "Turn on automatic updates" },
      dismissable: true,
    }));
}

export function storeUnreachable({ sources }) {
  if (!sources || sources.updates !== "failed") return null;
  return {
    id: "store-unreachable",
    severity: "info",
    topic: "updates",
    title: "Can't check for updates",
    why: "Your AVADO could not reach the AVADO store. Check that it is connected to the internet; your apps keep running meanwhile.",
    fix: { kind: "steps", label: "What to check" },
    steps: [
      "Check that the network cable is plugged in and your router has internet.",
      "Restart your router if other devices on your network are offline too.",
      "Reload this page. The check runs again every 10 minutes.",
    ],
  };
}
