import { getClient } from "health/clients";
import { appTitle } from "./apps";

// Validators that propose a block send its transaction fees to their fee
// recipient. `feeRecipients` (health/feeRecipients.js) only lists clients it
// could read; a client it could not read gives no finding.
export function feeRecipientMissing({ packages, feeRecipients }) {
  return Object.entries(feeRecipients || {})
    .filter(([, r]) => r && r.validators > 0 && r.missing > 0)
    .map(([name, r]) => {
      const pkg = (packages || []).find(p => p && p.name === name);
      const client = getClient(name);
      const label = pkg ? appTitle(pkg) : (client && client.label) || name.split(".")[0];
      const sampled = r.checked < r.validators ? ` (checked ${r.checked} of ${r.validators})` : "";
      return {
        id: `fee-recipient-missing:${name}`,
        severity: "critical",
        topic: "setup",
        appId: name,
        title: `Validators in ${label} have no fee recipient`,
        why: "When a validator proposes a block, the block's transaction fees go to its fee recipient. Without one, your validators lose those rewards.",
        detail: `${r.missing} validator${r.missing === 1 ? "" : "s"} without a fee recipient${sampled}`,
        fix: { kind: "link", to: `/packages/${name}`, label: "Open the app" },
        steps: [
          "Open the app and set your Ethereum address as the fee recipient in its settings.",
          "If these are Rocket Pool validators, open Rocket Pool: it sets the fee recipient for its validators.",
          "This check runs again every few minutes.",
        ],
      };
    });
}
feeRecipientMissing.needs = "feeRecipients";
