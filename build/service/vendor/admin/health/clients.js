// Which installed AVADO package plays which role on which network.
// Names come from the DappStore manifest (verified 2026-09-22) and the
// Prometheus job list in AVADO-DNP-Prometheus. Unknown packages return null
// and are ignored by role-based checks.

export const ROLES = {
  EXECUTION: "execution",
  CONSENSUS: "consensus",
  VALIDATOR: "validator",
  MEV: "mev",
  MONITORING: "monitoring",
  REMOTE: "remote",
};

export const NETWORKS = {
  mainnet: { label: "Ethereum mainnet", genesis: 1606824023, slotSeconds: 12, slotsPerEpoch: 32 },
  holesky: { label: "Holesky testnet", genesis: 1695902400, slotSeconds: 12, slotsPerEpoch: 32 },
  goerli: { label: "Goerli testnet (retired)", genesis: 1616508000, slotSeconds: 12, slotsPerEpoch: 32 },
  gnosis: { label: "Gnosis chain", genesis: 1638993340, slotSeconds: 5, slotsPerEpoch: 16 },
};

const EXECUTION_PRUNE =
  "Execution clients keep the whole chain state and grow over time. Resetting its data makes it sync again from scratch (several hours to a few days). No validator keys are stored in an execution client, so this is safe, but your validators cannot attest until it is synced again.";
const CONSENSUS_PRUNE =
  "Consensus clients normally stay under 200 GB. If yours is much larger, contact support: its data folder also holds your validator keys and slashing protection, so never delete it yourself.";

const table = [
  // Execution
  ["ethchain-geth.public.dappnode.eth", ROLES.EXECUTION, "mainnet", "Geth", "geth"],
  ["avado-dnp-nethermind.public.dappnode.eth", ROLES.EXECUTION, "mainnet", "Nethermind", "nethermind"],
  ["holesky-geth.avado.dnp.dappnode.eth", ROLES.EXECUTION, "holesky", "Geth (Holesky)", "geth"],
  ["goerli-geth.avado.dnp.dappnode.eth", ROLES.EXECUTION, "goerli", "Geth (Goerli)", "geth"],
  ["nethermind-gnosis.avado.dnp.dappnode.eth", ROLES.EXECUTION, "gnosis", "Nethermind (Gnosis)", "nethermind"],
  // Consensus (beacon + validator in one package, except Prysm)
  ["nimbus.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Nimbus", "nimbus"],
  ["nimbus-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Nimbus (Holesky)", "nimbus"],
  ["nimbus-prater.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "goerli", "Nimbus (Prater)", "nimbus"],
  ["teku.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Teku", "teku"],
  ["lighthouse.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Lighthouse", "lighthouse"],
  ["teku-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Teku (Holesky)", "teku"],
  ["teku-prater.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "goerli", "Teku (Prater)", "teku"],
  ["teku-gnosis.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "gnosis", "Teku (Gnosis)", "teku"],
  ["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Prysm beacon chain", "prysm"],
  ["eth2validator.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "mainnet", "Prysm", "prysm"],
  // Tooling
  ["mevboost.avado.dnp.dappnode.eth", ROLES.MEV, "mainnet", "MEV-Boost"],
  ["grafana.avado.dappnode.eth", ROLES.MONITORING, null, "Grafana"],
  ["prometheus.avado.dappnode.eth", ROLES.MONITORING, null, "Prometheus"],
  ["node-exporter.avado.dappnode.eth", ROLES.MONITORING, null, "Node exporter"],
  ["remoteconnect.avado.dnp.dappnode.eth", ROLES.REMOTE, null, "Remote Connect"],
  ["vpn.dnp.dappnode.eth", ROLES.REMOTE, null, "VPN"],
];

const byName = Object.fromEntries(
  table.map(([name, role, network, label, promClient]) => [
    name,
    {
      name,
      role,
      network,
      label,
      promClient,
      canResetData: role === ROLES.EXECUTION,
      pruneAdvice:
        role === ROLES.EXECUTION ? EXECUTION_PRUNE : role === ROLES.CONSENSUS ? CONSENSUS_PRUNE : null,
    },
  ])
);

export const PROMETHEUS_PACKAGE = "prometheus.avado.dappnode.eth";
export const GRAFANA_PACKAGE = "grafana.avado.dappnode.eth";

export function getClient(name) {
  return (name && byName[name]) || null;
}

export function clientsByRole(packages, role) {
  return (packages || [])
    .map(pkg => ({ pkg, client: getClient(pkg && pkg.name) }))
    .filter(({ client }) => client && client.role === role);
}

export function currentSlot(network, nowMs) {
  const n = NETWORKS[network];
  if (!n) return null;
  return Math.floor((nowMs / 1000 - n.genesis) / n.slotSeconds);
}
