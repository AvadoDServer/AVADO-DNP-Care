import assert from "node:assert/strict";
import { test } from "node:test";
import type { Metrics } from "../src/admin/health/types.js";
import { silentLogger } from "../src/log.js";
import { cleanPackage, parseChainDataMessage, runHealthCheck, type SnapshotDeps } from "../src/snapshot.js";
import { NODE_ID, pkg } from "./helpers.js";

const NOW = 1790103551 * 1000;

function deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps & { metricsCalls: number } {
  const d = {
    metricsCalls: 0,
    listPackages: async () => [pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: "10.0.48" })],
    getStats: async () => ({ disk: "42%", cpu: "5%", memory: "30%", diskTotal: "1.8 TB", diskUsed: "0.7 TB" }),
    getParams: async () => ({ nodeid: NODE_ID, ip: "85.84.83.82", internalip: "192.168.1.20", domain: "x.dyndns.io" }),
    fetchChainData: async () => [],
    fetchStorePackages: async () => [],
    fetchMetrics: async (): Promise<Metrics | null> => {
      d.metricsCalls++;
      return null;
    },
    fetchFeeRecipients: async () => null,
    updateAges: () => null,
    now: () => NOW,
    ...overrides,
  };
  return d;
}

test("a healthy box: verdict ok, no findings", async () => {
  const r = await runHealthCheck(deps(), silentLogger);
  assert.equal(r.ready, true);
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.findings.filter((f) => f.severity !== "info"), []);
  assert.equal(r.sources.updates, "ok");
  assert.equal(r.sources.metrics, "not-installed");
});

test("the Admin rules run: a stopped client is critical, a disk at 92% is critical", async () => {
  const r = await runHealthCheck(
    deps({
      listPackages: async () => [
        pkg("nimbus.avado.dnp.dappnode.eth", { state: "exited", running: false }),
        pkg("ethchain-geth.public.dappnode.eth"),
      ],
      getStats: async () => ({ disk: "92%" }),
    }),
    silentLogger,
  );
  assert.equal(r.verdict, "critical");
  const ids = r.findings.map((f) => `${f.severity}:${f.id}`);
  assert.ok(ids.includes("critical:app-stopped:nimbus.avado.dnp.dappnode.eth"), ids.join(", "));
  assert.ok(ids.includes("critical:disk-high"), ids.join(", "));
});

test("store updates come from the catalogue and use the node id", async () => {
  let asked: { nodeid: string; packages: unknown } | null = null;
  const r = await runHealthCheck(
    deps({
      listPackages: async () => [pkg("nimbus.avado.dnp.dappnode.eth", { version: "1.0.0" }), pkg("ethchain-geth.public.dappnode.eth")],
      fetchStorePackages: async (nodeid, packages) => {
        asked = { nodeid, packages };
        return [{ manifest: { name: "nimbus.avado.dnp.dappnode.eth", version: "1.2.0" }, manifesthash: "/ipfs/Qm1" }];
      },
    }),
    silentLogger,
  );
  assert.equal(asked!.nodeid, NODE_ID);
  assert.deepEqual(r.snapshot.updates, { "nimbus.avado.dnp.dappnode.eth": { from: "1.0.0", to: "1.2.0", hash: "/ipfs/Qm1" } });
  assert.ok(r.findings.some((f) => f.id === "updates-available"));
});

test("an unreachable store is reported like in the Admin (storeUnreachable)", async () => {
  const r = await runHealthCheck(deps({ fetchStorePackages: async () => Promise.reject(new Error("offline")) }), silentLogger);
  assert.equal(r.sources.updates, "failed");
  assert.ok(r.findings.some((f) => f.id === "store-unreachable"));
});

test("Prometheus is asked only while the monitoring package runs", async () => {
  const off = deps();
  await runHealthCheck(off, silentLogger);
  assert.equal(off.metricsCalls, 0);

  const on = deps({
    listPackages: async () => [pkg("prometheus.avado.dappnode.eth"), pkg("nimbus.avado.dnp.dappnode.eth"), pkg("ethchain-geth.public.dappnode.eth")],
  });
  const r = await runHealthCheck(on, silentLogger);
  assert.equal(on.metricsCalls, 1);
  assert.equal(r.sources.metrics, "failed");
  assert.ok(r.findings.some((f) => f.id === "metrics-unavailable"));
});

test("metrics feed the attestation rules", async () => {
  const metrics: Metrics = {
    headSlot: [],
    peers: [],
    attesterMiss: [{ client: "nimbus", network: "mainnet", value: 30 }],
    attesterHit: [{ client: "nimbus", network: "mainnet", value: 2 }],
  };
  const r = await runHealthCheck(
    deps({
      listPackages: async () => [pkg("prometheus.avado.dappnode.eth"), pkg("nimbus.avado.dnp.dappnode.eth"), pkg("ethchain-geth.public.dappnode.eth")],
      fetchMetrics: async () => metrics,
    }),
    silentLogger,
  );
  const f = r.findings.find((x) => x.id === "missed-attestations:nimbus.avado.dnp.dappnode.eth");
  assert.equal(f?.severity, "critical");
});

test("no package list: verdict 'checking' and no findings (never a false 'all good')", async () => {
  const r = await runHealthCheck(deps({ listPackages: async () => Promise.reject(new Error("no WAMP")) }), silentLogger);
  assert.equal(r.ready, false);
  assert.equal(r.verdict, "checking");
  assert.deepEqual(r.findings, []);
});

test("secrets from listPackages (env files) and IPs from getParams never enter the snapshot", async () => {
  const r = await runHealthCheck(
    deps({
      listPackages: async () => [
        pkg("rocketpool.avado.dnp.dappnode.eth", { envs: { PASSWORD: "hunter2hunter2" }, ports: [{ PublicPort: 1 }], origin: "/ipfs/x" }),
      ],
    }),
    silentLogger,
  );
  const text = JSON.stringify(r.snapshot);
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("85.84.83.82"));
  assert.ok(!text.includes("192.168.1.20"));
  assert.ok(!text.includes("dyndns"));
  assert.deepEqual(r.snapshot.params, { nodeid: NODE_ID });
});

test("cleanPackage keeps what the rules read", () => {
  const p = cleanPackage(pkg("x.avado.dnp.dappnode.eth", { volumes: [{ name: "v", size: "1.5GB", path: "/secret/path" }], manifest: { title: "X", autoupdate: false } }));
  assert.deepEqual(p!.volumes, [{ size: "1.5GB" }]);
  assert.equal(p!.manifest!.title, "X");
  assert.equal(cleanPackage({}), null);
});

test("chainData messages are parsed like the Admin's parseChainDataMessages", () => {
  assert.deepEqual(parseChainDataMessage({ name: "ethchain", message: "connect ECONNREFUSED", syncing: false }), {
    name: "Mainnet",
    message: "DNP stopped or unreachable (connection refused)",
    syncing: false,
  });
  assert.equal(parseChainDataMessage({ name: "Geth", message: "Blocks synced #0" })!.syncing, true);
});
