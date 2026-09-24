import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CareService, MESSAGES, type CareDeps } from "../src/care.js";
import type { Config } from "../src/config.js";
import { sha256Hex } from "../src/heartbeat.js";
import { silentLogger } from "../src/log.js";
import { StateStore, emptyState } from "../src/state.js";
import { FakeWamp, NODE_ID, SIGNATURE, dappmanagerHandlers, envelope, fakeFetch, jsonResponse, pkg, testConfig, type Handler } from "./helpers.js";

const NOW = 1790103551 * 1000;
const PACKAGES = [pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: "10.0.48" }), pkg("nimbus.avado.dnp.dappnode.eth"), pkg("ethchain-geth.public.dappnode.eth")];

function backend(heartbeat: (body: Record<string, unknown>) => Response) {
  return fakeFetch((url, init) => {
    if (url === "https://backend.test/api/care/heartbeat") return heartbeat(JSON.parse(String(init!.body)));
    if (url.startsWith("https://rpc.test")) return jsonResponse(200, { jsonrpc: "2.0", id: 0, result: JSON.stringify({ hash: "QmStore" }) });
    if (url === "http://ipfs.test:8080/ipfs/QmStore") return jsonResponse(200, { packages: [] });
    return new Response("not found", { status: 404 });
  });
}

function service(opts: { handlers?: Record<string, Handler>; fetch: typeof fetch; config?: Partial<Config>; now?: () => number }) {
  const config = testConfig(opts.config);
  const wamps: FakeWamp[] = [];
  const store = new StateStore(config.stateDir, silentLogger);
  const deps: CareDeps = {
    openWamp: () => {
      const w = new FakeWamp(opts.handlers ?? dappmanagerHandlers(PACKAGES));
      wamps.push(w);
      return w;
    },
    fetch: opts.fetch,
    now: opts.now ?? (() => NOW),
    store,
  };
  const care = new CareService(config, silentLogger, deps, emptyState());
  return { care, config, wamps, store };
}

test("a full cycle signs the exact payload and sends it to the backend (contracts A and B)", async () => {
  let received: Record<string, unknown> | null = null;
  const f = backend((body) => {
    received = body;
    return jsonResponse(200, { ok: true, subscribed: true, nextInSec: 600 });
  });
  const { care, wamps, config } = service({ fetch: f.fetch });
  await care.runOnce();
  care.stop();

  const body = received as unknown as { nodeId: string; timestamp: number; signature: string; payload: string };
  assert.deepEqual(Object.keys(body), ["nodeId", "timestamp", "signature", "payload"]);
  assert.equal(body.nodeId, NODE_ID);
  assert.equal(body.signature, SIGNATURE);
  assert.equal(body.timestamp, Math.floor(NOW / 1000));
  const sign = wamps[0]!.calls.find((c) => c.procedure.startsWith("signPrioritySupportRequest"))!;
  assert.deepEqual(sign.kwargs, { action: "care-heartbeat", timestamp: body.timestamp, payloadHash: sha256Hex(body.payload) });
  const payload = JSON.parse(body.payload);
  assert.equal(payload.verdict, "ok");
  assert.deepEqual(payload.disk, { usedPct: 42 });
  assert.equal(wamps[0]!.closed, true, "the WAMP session is closed after each cycle");

  const s = care.status();
  assert.equal(s.lastHeartbeat.ok, true);
  assert.equal(s.lastHeartbeat.error, null);
  assert.equal(s.subscribed, true);
  assert.equal(s.verdict, "ok");
  assert.equal(s.version, "0.1.0");
  assert.equal(s.checking, false);
  assert.deepEqual(s.sources, { packages: "ok", stats: "ok", params: "ok", chainData: "ok", updates: "ok", metrics: "not-installed" });

  // persisted for the next start
  const saved = JSON.parse(readFileSync(path.join(config.stateDir, "state.json"), "utf8"));
  assert.equal(saved.subscribed, true);
  assert.equal(saved.lastHeartbeat.ok, true);
  assert.equal(JSON.stringify(saved).includes(SIGNATURE), false, "signatures are not stored");
});

test("the backend's nextInSec sets the next check, within bounds", async () => {
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: false, nextInSec: 5 }));
  const { care } = service({ fetch: f.fetch });
  await care.runOnce();
  const next = Date.parse(care.status().nextCheckAt!);
  care.stop();
  assert.equal(next - NOW, 5 * 60 * 1000, "clamped to the 5 minute minimum");
  assert.equal(care.status().subscribed, false);
});

test("an outdated DAPPMANAGER: plain message, and signing is not retried until it changes", async () => {
  let signCalls = 0;
  let dmVersion = "10.0.47";
  const handlers: Record<string, Handler> = {
    ...dappmanagerHandlers([]),
    listPackages: () => envelope([pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: dmVersion })]),
    signPrioritySupportRequest: () => {
      signCalls++;
      return JSON.stringify({ success: false, message: "kwarg action must be one of: checkout, portal" });
    },
  };
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  const { care } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  assert.equal(care.status().lastHeartbeat.error, MESSAGES.outdated);
  await care.runOnce();
  assert.equal(signCalls, 1, "not retried on the same DAPPMANAGER version");
  dmVersion = "10.0.48";
  await care.runOnce();
  care.stop();
  assert.equal(signCalls, 2, "retried after the DAPPMANAGER changed");
  assert.equal(f.calls.filter((c) => c.url.includes("/api/care/")).length, 0, "nothing sent without a signature");
});

test("backend and network failures become plain messages", async () => {
  const cases: Array<[() => Response | Promise<Response>, string]> = [
    [() => jsonResponse(401, { error: "Invalid signature" }), MESSAGES.signature],
    [() => jsonResponse(429, { error: "Too many" }), MESSAGES.slowDown],
    [() => jsonResponse(503, { error: "down" }), MESSAGES.offline],
    [() => Promise.reject(new TypeError("fetch failed")), MESSAGES.offline],
  ];
  for (const [reply, message] of cases) {
    const f = backend(reply as () => Response);
    const { care } = service({ fetch: f.fetch });
    await care.runOnce();
    care.stop();
    assert.equal(care.status().lastHeartbeat.ok, false);
    assert.equal(care.status().lastHeartbeat.error, message);
  }
});

test("no WAMP at all: verdict 'checking' and a plain message", async () => {
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  const { care } = service({ handlers: {}, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  const s = care.status();
  assert.equal(s.verdict, "checking");
  assert.equal(s.lastHeartbeat.error, MESSAGES.dappmanager);
});

test("check-now joins a running check and refuses a second one within the cooldown", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let hbCount = 0;
  const f = backend(() => {
    hbCount++;
    return jsonResponse(200, { ok: true, subscribed: true });
  });
  const slow = dappmanagerHandlers(PACKAGES);
  const handlers: Record<string, Handler> = { ...slow, listPackages: async (kw) => (await gate, slow.listPackages!(kw)) };
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  const a = care.checkNow();
  const b = care.checkNow();
  assert.equal(care.status().checking, true);
  release();
  assert.deepEqual(await a, { ran: true });
  assert.deepEqual(await b, { ran: true });
  assert.equal(hbCount, 1, "both callers shared one run");
  now += 10_000;
  assert.deepEqual(await care.checkNow(), { ran: false });
  now += 60_000;
  assert.deepEqual(await care.checkNow(), { ran: true });
  care.stop();
  assert.equal(hbCount, 2);
});

test("state survives a restart", async () => {
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  const { care, config, store } = service({ fetch: f.fetch });
  await care.runOnce();
  care.stop();
  const restored = new CareService(config, silentLogger, { openWamp: () => new FakeWamp({}), fetch: f.fetch, now: () => NOW, store }, await store.load());
  assert.equal(restored.status().subscribed, true);
  assert.equal(restored.status().lastHeartbeat.ok, true);
  assert.equal(restored.status().lastCheckAt, new Date(NOW).toISOString());
});

/** A DAPPMANAGER that, like contract A, refuses timestamps more than 10 minutes from its own clock (NOW). */
function clockCheckingHandlers(): { handlers: Record<string, Handler>; signed: number[] } {
  const signed: number[] = [];
  const base = dappmanagerHandlers(PACKAGES);
  return {
    signed,
    handlers: {
      ...base,
      signPrioritySupportRequest: (kw) => {
        const ts = kw.timestamp as number;
        if (Math.abs(ts - NOW / 1000) > 600) return JSON.stringify({ success: false, message: "kwarg timestamp is more than 10 minutes from this AVADO's clock" });
        signed.push(ts);
        return base.signPrioritySupportRequest!(kw);
      },
    },
  };
}

test("a 401 with serverTime: re-signed once with the backend's clock and retried", async () => {
  const serverTime = NOW / 1000 + 400; // box clock 400 s behind, within the DAPPMANAGER's 10 min
  const bodies: Array<Record<string, unknown>> = [];
  const f = backend((body) => {
    bodies.push(body);
    return bodies.length === 1 ? jsonResponse(401, { error: "Timestamp out of range", serverTime }) : jsonResponse(200, { ok: true, subscribed: true });
  });
  const { handlers, signed } = clockCheckingHandlers();
  const { care } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  assert.deepEqual(signed, [NOW / 1000, serverTime]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.timestamp, serverTime);
  assert.equal(bodies[1]!.payload, bodies[0]!.payload, "the same payload is re-signed");
  assert.equal(care.status().lastHeartbeat.ok, true);
});

test("a 401 with a serverTime the DAPPMANAGER refuses: the box's clock is wrong", async () => {
  let posts = 0;
  const f = backend(() => {
    posts++;
    return jsonResponse(401, { error: "Timestamp out of range", serverTime: NOW / 1000 + 3 * 3600 });
  });
  const { handlers } = clockCheckingHandlers();
  const { care } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  assert.equal(posts, 1);
  assert.equal(care.status().lastHeartbeat.error, "Your AVADO's clock is wrong, so AVADO can't receive its check-ins.");
});

test("the time retry happens once, and never for a 401 without serverTime", async () => {
  let posts = 0;
  const always401 = backend(() => {
    posts++;
    return jsonResponse(401, { error: "Timestamp out of range", serverTime: NOW / 1000 + 60 });
  });
  const a = service({ handlers: clockCheckingHandlers().handlers, fetch: always401.fetch });
  await a.care.runOnce();
  a.care.stop();
  assert.equal(posts, 2);
  assert.equal(a.care.status().lastHeartbeat.error, MESSAGES.signature);

  posts = 0;
  const badSig = backend(() => {
    posts++;
    return jsonResponse(401, { error: "Invalid signature" });
  });
  const b = service({ fetch: badSig.fetch });
  await b.care.runOnce();
  b.care.stop();
  assert.equal(posts, 1);
  assert.equal(b.care.status().lastHeartbeat.error, MESSAGES.signature);
});
