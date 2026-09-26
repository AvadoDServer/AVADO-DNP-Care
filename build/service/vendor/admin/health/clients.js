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

// testnet: no real money at stake, so its apps are the first ones an owner
// short of disk space can remove (see health/rules/storage.js).
export const NETWORKS = {
  mainnet: { label: "Ethereum mainnet", genesis: 1606824023, slotSeconds: 12, slotsPerEpoch: 32 },
  holesky: { label: "Holesky testnet", genesis: 1695902400, slotSeconds: 12, slotsPerEpoch: 32, testnet: true },
  // Retired: the chain no longer runs, so checks about live validators skip it.
  goerli: { label: "Goerli testnet (retired)", genesis: 1616508000, slotSeconds: 12, slotsPerEpoch: 32, retired: true, testnet: true },
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
  // Lighthouse holesky/gnosis: names from AVADO-DNP-Lighthouse's
  // dappnode_package-*.json, labels from the Prometheus lighthouse job.
  ["lighthouse-holesky.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "holesky", "Lighthouse (Holesky)", "lighthouse"],
  ["lighthouse-gnosis.avado.dnp.dappnode.eth", ROLES.CONSENSUS, "gnosis", "Lighthouse (Gnosis)", "lighthouse"],
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

// Every consensus package runs a validator client and can hold validator
// keys, except Prysm's beacon chain: Prysm's validator is its own app
// (eth2validator).
const NO_VALIDATOR_CLIENT = new Set(["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth"]);

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
      holdsKeys: role === ROLES.CONSENSUS && !NO_VALIDATOR_CLIENT.has(name),
      pruneAdvice:
        role === ROLES.EXECUTION ? EXECUTION_PRUNE : role === ROLES.CONSENSUS ? CONSENSUS_PRUNE : null,
    },
  ])
);

export const PROMETHEUS_PACKAGE = "prometheus.avado.dappnode.eth";
export const GRAFANA_PACKAGE = "grafana.avado.dappnode.eth";
export const NODE_EXPORTER_PACKAGE = "node-exporter.avado.dappnode.eth";
// Rocket Pool keeps its validator keys inside its own node wallet.
export const ROCKET_POOL_PACKAGE = "rocketpool.avado.dnp.dappnode.eth";

export function getClient(name) {
  return (name && byName[name]) || null;
}

export function clientsByRole(packages, role) {
  return (packages || [])
    .map(pkg => ({ pkg, client: getClient(pkg && pkg.name) }))
    .filter(({ client }) => client && client.role === role);
}

// Installed apps that can hold validator keys on a network that still runs.
// Stopped apps count too: they start again by themselves after a reboot or
// an update (restart "always", and every update runs the app).
export function keyHolders(packages) {
  return clientsByRole(packages, ROLES.CONSENSUS).filter(
    ({ client }) => client.holdsKeys && !(NETWORKS[client.network] && NETWORKS[client.network].retired)
  );
}

export function currentSlot(network, nowMs) {
  const n = NETWORKS[network];
  if (!n) return null;
  return Math.floor((nowMs / 1000 - n.genesis) / n.slotSeconds);
}
