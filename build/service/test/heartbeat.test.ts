import assert from "node:assert/strict";
import { test } from "node:test";
import { HEARTBEAT_KEYS, buildHeartbeatPayload, parseHeartbeatResponse, postSigned, sha256Hex, BackendError } from "../src/heartbeat.js";
import { silentLogger } from "../src/log.js";
import { runHealthCheck, type CheckResult } from "../src/snapshot.js";
import { NODE_ID, SIGNATURE, fakeFetch, jsonResponse, pkg } from "./helpers.js";

async function check(): Promise<CheckResult> {
  return runHealthCheck(
    {
      listPackages: async () => [
        pkg("nimbus.avado.dnp.dappnode.eth", { state: "exited", running: false, version: "1.2.3", envs: { SECRET: "s3cr3t-value" } }),
        pkg("ethchain-geth.public.dappnode.eth", { version: "0.1.9" }),
        pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: "10.0.48" }),
      ],
      getStats: async () => ({ disk: "81.5%" }),
      getParams: async () => ({ nodeid: NODE_ID, ip: "85.84.83.82", internalip: "192.168.1.20" }),
      fetchChainData: async () => [{ name: "Nimbus", syncing: true, message: "peer 1.2.3.4 slot 5" }],
      fetchStorePackages: async () => Promise.reject(new Error("offline")),
      fetchMetrics: async () => null,
      now: () => 1790103551000,
    },
    silentLogger,
  );
}

test("the payload has exactly the contract-B fields", async () => {
  const p = buildHeartbeatPayload(await check(), "0.1.0");
  assert.deepEqual(Object.keys(p), [...HEARTBEAT_KEYS]);
  assert.equal(p.v, 1);
  assert.equal(p.verdict, "critical");
  assert.deepEqual(p.disk, { usedPct: 81.5 });
  assert.deepEqual(p.care, { version: "0.1.0" });
  assert.deepEqual(p.packages, [
    { name: "dappmanager.dnp.dappnode.eth", version: "10.0.48" },
    { name: "ethchain-geth.public.dappnode.eth", version: "0.1.9" },
    { name: "nimbus.avado.dnp.dappnode.eth", version: "1.2.3" },
  ]);
  for (const f of p.findings) {
    assert.deepEqual(Object.keys(f), ["id", "level", "title"]);
    assert.ok(f.level === "critical" || f.level === "warning");
  }
  assert.ok(p.findings.some((f) => f.id === "app-stopped:nimbus.avado.dnp.dappnode.eth" && f.level === "critical"));
  assert.ok(p.findings.some((f) => f.id === "disk-high" && f.level === "warning"));
  // info findings (store unreachable, syncing) stay on the box
  assert.ok(!p.findings.some((f) => f.id === "store-unreachable" || f.id.startsWith("chain-syncing")));
});

test("privacy: no keys, IPs, env values, peers, node id or finding explanations in the payload", async () => {
  const text = JSON.stringify(buildHeartbeatPayload(await check(), "0.1.0"));
  for (const bad of ["85.84.83.82", "192.168.1.20", "1.2.3.4", "s3cr3t", NODE_ID, "why", "detail", "steps", "nodeid"]) {
    assert.ok(!text.includes(bad), `payload contains ${bad}`);
  }
});

test("no disk reading gives disk:null", async () => {
  const c = await check();
  c.snapshot.stats = {};
  assert.equal(buildHeartbeatPayload(c, "0.1.0").disk, null);
});

test("sha256Hex is the lowercase hex sha256 of the exact string", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("postSigned sends the signed body as JSON and returns the reply", async () => {
  const f = fakeFetch(() => jsonResponse(200, { ok: true, subscribed: true, nextInSec: 600 }));
  const body = { nodeId: NODE_ID, timestamp: 1, signature: SIGNATURE, payload: "{}" };
  const r = await postSigned("https://backend.test", "/api/care/heartbeat", body, f.fetch);
  assert.deepEqual(parseHeartbeatResponse(r), { ok: true, subscribed: true, nextInSec: 600, emailVerified: null });
  assert.equal(f.calls[0]!.url, "https://backend.test/api/care/heartbeat");
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init!.body)), body);
});

test("postSigned turns backend errors into BackendError with the plain message", async () => {
  const f = fakeFetch(() => jsonResponse(401, { error: "Bad signature" }));
  await assert.rejects(postSigned("https://b", "/x", { nodeId: "", timestamp: 1, signature: "", payload: "" }, f.fetch), (e: unknown) => e instanceof BackendError && e.status === 401 && e.message === "Bad signature");
  const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(postSigned("https://b", "/x", { nodeId: "", timestamp: 1, signature: "", payload: "" }, down.fetch), (e: unknown) => e instanceof BackendError && e.status === null);
});

test("finding ids and titles are clipped to the backend's limits", async () => {
  const c = await check();
  c.findings = [{ id: "x".repeat(300), severity: "critical", topic: "sync", title: "t".repeat(500) }];
  const [f] = buildHeartbeatPayload(c, "0.1.0").findings;
  assert.equal(f!.id.length, 120);
  assert.ok(f!.title.length <= 200);
});
