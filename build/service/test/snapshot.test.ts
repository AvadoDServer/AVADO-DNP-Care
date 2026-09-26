import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecksDetailed } from "../src/admin/health/engine.js";
import { QUERIES } from "../src/admin/health/prometheus.js";
import { ALL_RULES } from "../src/admin/health/rules/index.js";
import type { MetricSample, Metrics, Rule } from "../src/admin/health/types.js";
import { silentLogger } from "../src/log.js";
import {
  carryOverFindings,
  cleanPackage,
  failedMetricKeys,
  failedSources,
  METRIC_FINDINGS,
  parseChainDataMessage,
  runHealthCheck,
  type PreviousFinding,
  type SnapshotDeps,
} from "../src/snapshot.js";
import { NODE_ID, pkg } from "./helpers.js";

const NOW = 1790103551 * 1000;
/** The mainnet slot at NOW (clients.js currentSlot). */
const WALL_SLOT = Math.floor((NOW / 1000 - 1606824023) / 12);
const MONITORED_BOX = async () => [pkg("prometheus.avado.dappnode.eth"), pkg("nimbus.avado.dnp.dappnode.eth"), pkg("ethchain-geth.public.dappnode.eth")];
const nimbus = (value: number): MetricSample[] => [{ client: "nimbus", network: "mainnet", value }];
const rule = (name: string): Rule => {
  const r = ALL_RULES.find((x) => x.name === name);
  assert.ok(r, `the Admin still has the rule ${name}`);
  return r;
};

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

test("nothing checks for a system update: the core-update rule is skipped, not counted as passed", async () => {
  const r = await runHealthCheck(deps(), silentLogger);
  assert.equal(r.snapshot.coreUpdate, null);
  assert.deepEqual(runChecksDetailed(r.snapshot, [rule("coreUpdateAvailable")]), { findings: [], passed: 0, total: 0 });
  // what Care 0.1.0 sent: a check that "ran and passed" although nothing was checked
  assert.deepEqual(runChecksDetailed({ ...r.snapshot, coreUpdate: { available: false } }, [rule("coreUpdateAvailable")]).total, 1);
});

test("no disk trend is read: the disk-full forecast is skipped and disk-high has no forecast", async () => {
  const r = await runHealthCheck(deps(), silentLogger);
  assert.equal(r.snapshot.diskTrend, null);
  assert.equal(runChecksDetailed(r.snapshot, [rule("diskFillingUp")]).total, 0);

  const high = (await runHealthCheck(deps({ getStats: async () => ({ disk: "85%" }) }), silentLogger)).findings.find((f) => f.id === "disk-high");
  assert.equal(high?.severity, "warning");
  assert.equal(high?.detail, undefined);
  assert.doesNotMatch(String(high?.why), /At this rate/);
});

test("tips the owner can hide in the Admin (two validator apps, automatic updates off) are not reported", async () => {
  const r = await runHealthCheck(
    deps({
      listPackages: async () => [
        pkg("nimbus.avado.dnp.dappnode.eth", { manifest: { name: "nimbus.avado.dnp.dappnode.eth", title: "Nimbus", autoupdate: false } }),
        pkg("teku.avado.dnp.dappnode.eth"),
        pkg("ethchain-geth.public.dappnode.eth"),
      ],
    }),
    silentLogger,
  );
  // the Admin's rules find both, as tips its Home can hide
  const admin = runChecksDetailed(r.snapshot, ALL_RULES).findings;
  assert.ok(admin.some((f) => f.id === "two-validator-clients:mainnet" && f.severity === "warning" && f.dismissable));
  assert.ok(admin.some((f) => f.id === "autoupdate-off:nimbus.avado.dnp.dappnode.eth" && f.dismissable));
  // Care can't hide them: not reported, and they don't make the verdict
  assert.deepEqual(r.findings.filter((f) => f.dismissable), []);
  assert.ok(!r.findings.some((f) => f.id.startsWith("two-validator-clients:")));
  assert.equal(r.verdict, "ok");
});

test("a partial Prometheus read is 'partial', and the queries that answered still run their rules", async () => {
  const r = await runHealthCheck(
    deps({
      listPackages: MONITORED_BOX,
      fetchMetrics: async () => ({ headSlot: nimbus(WALL_SLOT - 100), peers: null, attesterMiss: [], attesterHit: [] }),
    }),
    silentLogger,
  );
  assert.equal(r.sources.metrics, "partial");
  assert.equal(r.snapshot.sources.metrics, "partial");
  assert.deepEqual(failedMetricKeys(r.snapshot.metrics), ["peers"]);
  assert.deepEqual(failedSources(r), ["metrics.peers"]);
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes("head-behind:nimbus.avado.dnp.dappnode.eth"), ids.join(", "));
  assert.ok(!ids.includes("metrics-unavailable"), "Prometheus answered, so not 'can't read the metrics'");

  const down = await runHealthCheck(deps({ listPackages: MONITORED_BOX, fetchMetrics: async () => null }), silentLogger);
  assert.deepEqual(failedSources(down), ["metrics"], "Prometheus down: the whole input failed, not single queries");
});

test("every Prometheus query the Admin runs has its findings listed for the carry-over", () => {
  assert.deepEqual(Object.keys(METRIC_FINDINGS).sort(), Object.keys(QUERIES).sort());
});

const previous = (id: string, severity: PreviousFinding["severity"] = "warning"): PreviousFinding => ({ id, severity, topic: "sync", title: `before: ${id}`, why: null });

test("carry-over for one failed query: its findings are kept, the answered queries' findings clear", async () => {
  const check = await runHealthCheck(
    deps({ listPackages: MONITORED_BOX, fetchMetrics: async () => ({ headSlot: null, peers: nimbus(40), attesterMiss: [], attesterHit: [] }) }),
    silentLogger,
  );
  const was = [previous("head-behind:nimbus.avado.dnp.dappnode.eth"), previous("low-peers:nimbus.avado.dnp.dappnode.eth")];
  const r = carryOverFindings(check, was, new Set(failedSources(check)));
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes("head-behind:nimbus.avado.dnp.dappnode.eth"), "head slot unknown: kept");
  assert.ok(!ids.includes("low-peers:nimbus.avado.dnp.dappnode.eth"), "40 peers now: cleared");
  assert.equal(r.findings.find((f) => f.id === "head-behind:nimbus.avado.dnp.dappnode.eth")?.carried, true);
  assert.equal(r.verdict, "warning");
});

test("carry-over without the hit count: missed attestations keep their last severity instead of turning critical", async () => {
  const check = await runHealthCheck(
    deps({ listPackages: MONITORED_BOX, fetchMetrics: async () => ({ headSlot: [], peers: [], attesterMiss: nimbus(3), attesterHit: null }) }),
    silentLogger,
  );
  const id = "missed-attestations:nimbus.avado.dnp.dappnode.eth";
  // the rule still runs on the miss count alone, and reads every attestation as missed
  assert.equal(check.findings.find((f) => f.id === id)?.severity, "critical");
  assert.deepEqual(failedSources(check), ["metrics.attesterHit"]);

  const r = carryOverFindings(check, [previous(id, "warning")], new Set(failedSources(check)));
  assert.deepEqual(
    r.findings.filter((f) => f.id === id).map((f) => [f.severity, f.carried]),
    [["warning", true]],
  );
  assert.equal(r.verdict, "warning");
  const none = carryOverFindings(check, [], new Set(failedSources(check)));
  assert.ok(!none.findings.some((f) => f.id === id), "no alert raised on half the data");
});

test("a failed query that is not carried (no answer within 24 h): its findings are still not raised from half the data", async () => {
  const check = await runHealthCheck(
    deps({ listPackages: MONITORED_BOX, fetchMetrics: async () => ({ headSlot: [], peers: [], attesterMiss: nimbus(3), attesterHit: null }) }),
    silentLogger,
  );
  const id = "missed-attestations:nimbus.avado.dnp.dappnode.eth";
  assert.equal(check.findings.find((f) => f.id === id)?.severity, "critical");

  const r = carryOverFindings(check, [previous(id, "warning")], new Set());
  assert.ok(!r.findings.some((f) => f.id === id), "neither the critical nor the old warning");
  assert.ok(!r.findings.some((f) => f.severity === "critical"), r.findings.map((f) => f.id).join(", "));
  assert.notEqual(r.verdict, "critical");
});

test("carry-over leaves a check alone when every input answered", async () => {
  const check = await runHealthCheck(
    deps({ listPackages: MONITORED_BOX, fetchMetrics: async () => ({ headSlot: [], peers: [], attesterMiss: nimbus(3), attesterHit: nimbus(1) }) }),
    silentLogger,
  );
  const id = "missed-attestations:nimbus.avado.dnp.dappnode.eth";
  assert.deepEqual(failedSources(check), []);
  assert.equal(carryOverFindings(check, [previous(id, "warning")], new Set()), check, "the rule had all its data: its critical stands");
});

test("chainData messages are parsed like the Admin's parseChainDataMessages", () => {
  assert.deepEqual(parseChainDataMessage({ name: "ethchain", message: "connect ECONNREFUSED", syncing: false }), {
    name: "Mainnet",
    message: "DNP stopped or unreachable (connection refused)",
    syncing: false,
  });
  assert.equal(parseChainDataMessage({ name: "Geth", message: "Blocks synced #0" })!.syncing, true);
});
