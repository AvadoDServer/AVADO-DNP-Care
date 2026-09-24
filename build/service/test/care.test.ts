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
    random: () => 0.5, // no jitter
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
  assert.deepEqual(sign.kwargs, { action: "care-heartbeat", timestamp: body.timestamp, payloadHash: sha256Hex(body.payload), dontLogError: true });
  for (const c of wamps[0]!.calls) assert.equal(c.kwargs.dontLogError, true, `${c.procedure} without dontLogError`);
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
  assert.deepEqual(s.sources, { packages: "ok", stats: "ok", params: "ok", chainData: "ok", updates: "ok", metrics: "not-installed", feeRecipients: "failed" }); // Nimbus runs, its keymanager is not faked here

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
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  await care.runOnce();
  assert.equal(care.status().lastHeartbeat.error, MESSAGES.outdated);
  assert.equal(care.status().heartbeatIssue, "outdated");
  assert.equal(Date.parse(care.status().nextCheckAt!) - now, 60 * 60 * 1000, "checks run hourly while outdated");
  now += 61 * 60 * 1000;
  await care.runOnce();
  assert.equal(signCalls, 1, "not retried on the same DAPPMANAGER version");
  dmVersion = "10.0.48";
  now += 61 * 60 * 1000; // the package list (and so the DAPPMANAGER version) refreshes hourly
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
  assert.deepEqual(await a, { ran: true, done: true });
  assert.deepEqual(await b, { ran: true, done: true });
  assert.equal(hbCount, 1, "both callers shared one run");
  now += 10_000;
  assert.deepEqual(await care.checkNow(), { ran: false, done: true });
  now += 60_000;
  assert.deepEqual(await care.checkNow(), { ran: true, done: true });
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

test("a backend time more than 9 minutes off: clock error without asking the DAPPMANAGER, retried after 6 h", async () => {
  let posts = 0;
  const f = backend(() => {
    posts++;
    return jsonResponse(401, { error: "Timestamp out of range", serverTime: Math.floor(now / 1000) + 3 * 3600 });
  });
  let now = NOW;
  const signed: number[] = [];
  const base = dappmanagerHandlers(PACKAGES);
  const handlers: Record<string, Handler> = {
    ...base,
    signPrioritySupportRequest: (kw) => (signed.push(kw.timestamp as number), base.signPrioritySupportRequest!(kw)),
  };
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  await care.runOnce();
  assert.equal(posts, 1);
  assert.deepEqual(signed, [NOW / 1000], "the backend's time was never sent to the signer");
  assert.equal(care.status().lastHeartbeat.error, MESSAGES.clock);
  assert.equal(care.status().heartbeatIssue, "clock");

  now += 10 * 60 * 1000;
  await care.runOnce();
  assert.equal(signed.length, 1, "no signing for 6 hours");
  assert.equal(posts, 1);
  assert.equal(care.status().heartbeatIssue, "clock");

  now += 6 * 60 * 60 * 1000;
  await care.runOnce();
  care.stop();
  assert.equal(signed.length, 2, "tried again after 6 hours");
});

test("a backend time within 9 minutes that the DAPPMANAGER still refuses is a clock error", async () => {
  const serverTime = NOW / 1000 + 500;
  const f = backend(() => jsonResponse(401, { error: "Timestamp out of range", serverTime }));
  const base = dappmanagerHandlers(PACKAGES);
  const handlers: Record<string, Handler> = {
    ...base,
    signPrioritySupportRequest: (kw) =>
      kw.timestamp === serverTime ? JSON.stringify({ success: false, message: "timestamp too far from this AVADO's clock" }) : base.signPrioritySupportRequest!(kw),
  };
  const { care } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  assert.equal(care.status().heartbeatIssue, "clock");
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

test("the package list is read at start and then at most hourly; disk % every check", async () => {
  let listCalls = 0;
  let statsCalls = 0;
  let disk = "42%";
  const base = dappmanagerHandlers(PACKAGES);
  const handlers: Record<string, Handler> = {
    ...base,
    listPackages: (kw) => (listCalls++, base.listPackages!(kw)),
    getStats: () => (statsCalls++, envelope({ disk })),
  };
  const bodies: string[] = [];
  const f = backend((b) => (bodies.push(String(b.payload)), jsonResponse(200, { ok: true, subscribed: true })));
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  for (let i = 0; i < 6; i++) {
    if (i === 3) disk = "91%";
    await care.runOnce();
    now += 10 * 60 * 1000;
  }
  assert.equal(listCalls, 1);
  assert.equal(statsCalls, 6);
  assert.deepEqual(JSON.parse(bodies[3]!).disk, { usedPct: 91 });
  now += 1000;
  await care.runOnce();
  care.stop();
  assert.equal(listCalls, 2, "refreshed after an hour");
  const storeCalls = f.calls.filter((c) => c.url.startsWith("https://rpc.test")).length;
  assert.equal(storeCalls, 2, "the store is checked hourly too");
});

test("a failed input keeps its previous findings (no false 'cleared')", async () => {
  let statsOk = true;
  const base = dappmanagerHandlers(PACKAGES);
  const handlers: Record<string, Handler> = {
    ...base,
    getStats: () => (statsOk ? envelope({ disk: "93%" }) : JSON.stringify({ success: false, message: "df failed" })),
  };
  const bodies: Array<{ verdict: string; findings: Array<{ id: string }> }> = [];
  const f = backend((b) => (bodies.push(JSON.parse(String(b.payload))), jsonResponse(200, { ok: true, subscribed: true })));
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  await care.runOnce();
  statsOk = false;
  now += 10 * 60 * 1000;
  await care.runOnce();
  care.stop();
  assert.ok(bodies[0]!.findings.some((x) => x.id === "disk-high"));
  assert.ok(bodies[1]!.findings.some((x) => x.id === "disk-high"), "carried over while getStats fails");
  assert.equal(bodies[1]!.verdict, "critical");
  assert.equal(care.status().sources.stats, "failed");
});

test("an input that keeps failing pauses for 6 hours", async () => {
  let statsCalls = 0;
  const handlers: Record<string, Handler> = {
    ...dappmanagerHandlers(PACKAGES),
    getStats: () => (statsCalls++, JSON.stringify({ success: false, message: "df failed" })),
  };
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  for (let i = 0; i < 6; i++) {
    await care.runOnce();
    now += 10 * 60 * 1000;
  }
  assert.equal(statsCalls, 3, "three failures, then paused");
  now += 6 * 60 * 60 * 1000;
  await care.runOnce();
  care.stop();
  assert.equal(statsCalls, 4, "tried again after 6 hours");
});

test("every interval gets up to ±60 s of jitter", async () => {
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true, nextInSec: 600 }));
  const config = testConfig();
  const store = new StateStore(config.stateDir, silentLogger);
  const care = new CareService(config, silentLogger, { openWamp: () => new FakeWamp(dappmanagerHandlers(PACKAGES)), fetch: f.fetch, now: () => NOW, store, random: () => 1 }, emptyState());
  await care.runOnce();
  const next = Date.parse(care.status().nextCheckAt!);
  care.stop();
  assert.equal(next - NOW, 600_000 + 60_000);
});

test("a DAPPMANAGER without the signing procedure at all (other calls answer) counts as outdated", async () => {
  const { signPrioritySupportRequest: _drop, ...handlers } = dappmanagerHandlers(PACKAGES);
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  const { care } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  assert.equal(care.status().heartbeatIssue, "outdated");
  assert.equal(care.currentState.outdatedDappmanager, "10.0.48");
});

test("without a package list nothing is signed", async () => {
  const handlers: Record<string, Handler> = { ...dappmanagerHandlers(PACKAGES), listPackages: () => JSON.stringify({ success: false, message: "docker down" }) };
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  const { care, wamps } = service({ handlers, fetch: f.fetch });
  await care.runOnce();
  care.stop();
  assert.equal(care.status().verdict, "checking");
  assert.ok(!wamps[0]!.calls.some((c) => c.procedure.startsWith("signPrioritySupportRequest")));
});

const PUBKEY = (i: number) => "0x" + String(i).padStart(2, "0").repeat(48);
const ADDRESS = "0x" + "ab".repeat(20);

/** A backend + store + Nimbus keymanager. `fee(pubkey)` gives [status, body]. */
function boxWithKeymanager(opts: {
  keys: string[];
  fee: (pk: string) => [number, unknown];
  storeVersion?: string;
  keymanagerDown?: () => boolean;
  heartbeat?: (b: Record<string, unknown>) => void;
  /** The beacon node's validator statuses by pubkey (default: every key active). */
  chain?: Record<string, string>;
}) {
  return fakeFetch((url, init) => {
    if (url === "https://backend.test/api/care/heartbeat") {
      opts.heartbeat?.(JSON.parse(String(init!.body)));
      return jsonResponse(200, { ok: true, subscribed: true });
    }
    if (url.startsWith("https://rpc.test")) return jsonResponse(200, { jsonrpc: "2.0", id: 0, result: JSON.stringify({ hash: "QmStore" }) });
    if (url === "http://ipfs.test:8080/ipfs/QmStore") {
      const packages = opts.storeVersion ? [{ manifest: { name: "nimbus.avado.dnp.dappnode.eth", version: opts.storeVersion }, manifesthash: "/ipfs/QmN" }] : [];
      return jsonResponse(200, { packages });
    }
    const beacon = /^http:\/\/nimbus\.my\.ava\.do:5052\/eth\/v1\/beacon\/states\/head\/validators\?id=(.*)$/.exec(url);
    if (beacon) {
      const ids = beacon[1]!.split(",");
      const data = ids
        .map((id) => ({ id, status: opts.chain ? opts.chain[id] : "active_ongoing" }))
        .filter((x) => x.status)
        .map((x) => ({ status: x.status, validator: { pubkey: x.id } }));
      return jsonResponse(200, { data });
    }
    if (url.startsWith("http://nimbus.my.ava.do:9999/keymanager/")) {
      if (opts.keymanagerDown?.()) return Promise.reject(new TypeError("fetch failed"));
      if (url.endsWith("/eth/v1/keystores")) return jsonResponse(200, { data: opts.keys.map((k) => ({ validating_pubkey: k })) });
      const m = /validator\/(0x[0-9a-f]+)\/feerecipient$/.exec(url);
      if (m) return jsonResponse(...opts.fee(m[1]!));
    }
    return new Response("not found", { status: 404 });
  });
}

test("fee recipients: a zero address gives a critical finding without any address in the heartbeat; read hourly; kept through a failed read", async () => {
  const bodies: string[] = [];
  let down = false;
  const f = boxWithKeymanager({
    keys: [PUBKEY(1), PUBKEY(2)],
    fee: (pk) => [200, { data: { pubkey: pk, ethaddress: pk === PUBKEY(1) ? "0x" + "0".repeat(40) : ADDRESS } }],
    keymanagerDown: () => down,
    heartbeat: (b) => bodies.push(String(b.payload)),
  });
  let now = NOW;
  const { care } = service({ fetch: f.fetch, now: () => now });
  await care.runOnce();
  const p0 = JSON.parse(bodies[0]!);
  const finding = p0.findings.find((x: { id: string }) => x.id === "fee-recipient-missing:nimbus.avado.dnp.dappnode.eth");
  assert.deepEqual(finding, { id: "fee-recipient-missing:nimbus.avado.dnp.dappnode.eth", level: "critical", title: "Validators in nimbus have no fee recipient" });
  for (const secret of [PUBKEY(1).slice(2, 20), "abababab", "0x000000"]) assert.ok(!bodies[0]!.includes(secret), `heartbeat contains ${secret}`);

  const keymanagerCalls = () => f.calls.filter((c) => c.url.includes(":9999/keymanager/")).length;
  const first = keymanagerCalls();
  assert.equal(first, 3, "the key list and one fee recipient per key");
  now += 10 * 60 * 1000;
  await care.runOnce();
  assert.equal(keymanagerCalls(), first, "not read again within the hour");

  down = true;
  now += 61 * 60 * 1000;
  await care.runOnce();
  care.stop();
  assert.ok(JSON.parse(bodies[2]!).findings.some((x: { id: string }) => x.id.startsWith("fee-recipient-missing:")), "kept while the keymanager can't be read");
});

test("fee recipients: nothing when every key has one, when no keys are loaded, or when the answer is ambiguous", async () => {
  for (const [keys, fee] of [
    [[PUBKEY(1)], () => [200, { data: { ethaddress: ADDRESS } }]],
    [[], () => [200, {}]],
    [[PUBKEY(1)], () => [404, { message: "Could not find validator" }]],
    // Nimbus: zero for a key not in the chain state yet (pending, 0x01 credentials, no default)
    [[PUBKEY(1)], () => [200, { data: { ethaddress: "0x" + "0".repeat(40) } }]],
  ] as Array<[string[], (pk: string) => [number, unknown]]>) {
    const bodies: string[] = [];
    const f = boxWithKeymanager({ keys, fee, chain: {}, heartbeat: (b) => bodies.push(String(b.payload)) });
    const { care } = service({ fetch: f.fetch });
    await care.runOnce();
    care.stop();
    assert.ok(!bodies[0]!.includes("fee-recipient-missing"), JSON.stringify(keys));
  }
});

test("update blocked: critical after an update has waited 48 h; the first-seen time survives a restart", async () => {
  const bodies: string[] = [];
  const f = boxWithKeymanager({ keys: [], fee: () => [200, {}], storeVersion: "1.2.0", heartbeat: (b) => bodies.push(String(b.payload)) });
  let now = NOW;
  const { care, config, store } = service({ fetch: f.fetch, now: () => now });
  await care.runOnce();
  care.stop();
  assert.ok(!bodies[0]!.includes("update-blocked"));
  assert.deepEqual(care.currentState.updateAges, { "nimbus.avado.dnp.dappnode.eth": NOW });

  // restart 49 hours later
  now += 49 * 60 * 60 * 1000;
  const restarted = new CareService(config, silentLogger, { openWamp: () => new FakeWamp(dappmanagerHandlers(PACKAGES)), fetch: f.fetch, now: () => now, store, random: () => 0.5 }, await store.load());
  await restarted.runOnce();
  restarted.stop();
  const p = JSON.parse(bodies[1]!);
  assert.deepEqual(
    p.findings.find((x: { id: string }) => x.id === "update-blocked:nimbus.avado.dnp.dappnode.eth"),
    { id: "update-blocked:nimbus.avado.dnp.dappnode.eth", level: "critical", title: "nimbus can't update" },
  );
});

test("the 24 h carry-over limit survives a restart (restart at 23 h, cleared by 25 h)", async () => {
  let statsOk = true;
  const handlers = (): Record<string, Handler> => ({
    ...dappmanagerHandlers(PACKAGES),
    getStats: () => (statsOk ? envelope({ disk: "93%" }) : JSON.stringify({ success: false, message: "df failed" })),
  });
  const f = backend(() => jsonResponse(200, { ok: true, subscribed: true }));
  let now = NOW;
  const first = service({ handlers: handlers(), fetch: f.fetch, now: () => now });
  await first.care.runOnce();
  statsOk = false;
  now += 60 * 60 * 1000;
  await first.care.runOnce();
  first.care.stop();
  assert.ok(first.care.status().findings.some((x) => x.id === "disk-high"), "carried while getStats fails");

  // the container restarts 23 h after the last good read
  now = NOW + 23 * 60 * 60 * 1000;
  const saved = await first.store.load();
  assert.equal(saved.sourceOkAt.stats, NOW, "the last good read is on the volume");
  const restarted = new CareService(first.config, silentLogger, { openWamp: () => new FakeWamp(handlers()), fetch: f.fetch, now: () => now, store: first.store, random: () => 0.5 }, saved);
  await restarted.runOnce();
  assert.ok(restarted.status().findings.some((x) => x.id === "disk-high"), "still carried at 23 h");
  now = NOW + 25 * 60 * 60 * 1000;
  await restarted.runOnce();
  restarted.stop();
  assert.ok(!restarted.status().findings.some((x) => x.id === "disk-high"), "dropped after 24 h without a good read");
});

test("a package list that can't be refreshed for more than 24 h is not used any more", async () => {
  let listOk = true;
  const base = dappmanagerHandlers([...PACKAGES, pkg("rotki.avado.dnp.dappnode.eth", { state: "exited", running: false })]);
  const handlers: Record<string, Handler> = {
    ...base,
    listPackages: (kw) => (listOk ? base.listPackages!(kw) : JSON.stringify({ success: false, message: "a disk usage operation is already running" })),
  };
  const bodies: Array<{ verdict: string; findings: unknown[]; packages: unknown[] }> = [];
  const f = backend((b) => (bodies.push(JSON.parse(String(b.payload))), jsonResponse(200, { ok: true, subscribed: true })));
  let now = NOW;
  const { care } = service({ handlers, fetch: f.fetch, now: () => now });
  await care.runOnce();
  assert.ok(care.status().findings.some((x) => x.id === "app-stopped:rotki.avado.dnp.dappnode.eth"));
  listOk = false;
  now += 23 * 60 * 60 * 1000;
  await care.runOnce();
  assert.equal(care.status().sources.packages, "ok", "the cached list is still used within a day");
  assert.ok(care.status().findings.some((x) => x.id === "app-stopped:rotki.avado.dnp.dappnode.eth"));
  assert.equal(care.status().notice, null);

  now = NOW + 25 * 60 * 60 * 1000;
  await care.runOnce();
  care.stop();
  const s = care.status();
  assert.equal(s.sources.packages, "stale");
  assert.equal(s.verdict, "checking");
  assert.deepEqual(s.findings, [], "no findings from a stale package list");
  assert.match(s.notice!, /has not been able to list its apps for more than a day/);
  const last = bodies[bodies.length - 1]!;
  assert.equal(last.verdict, "checking", "the box still checks in, as 'checking'");
  assert.deepEqual(last.packages, []);
  assert.deepEqual(last.findings, []);
});
