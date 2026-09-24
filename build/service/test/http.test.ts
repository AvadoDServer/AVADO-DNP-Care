import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { CareService } from "../src/care.js";
import { isStatusCorsOrigin } from "../src/config.js";
import { isAllowedHost } from "../src/host.js";
import { PAGE_CSP, createApp } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { StateStore, emptyState } from "../src/state.js";
import { FakeWamp, dappmanagerHandlers, fakeFetch, jsonResponse, pkg, testConfig } from "./helpers.js";

const PACKAGES_OK = [pkg("dappmanager.dnp.dappnode.eth", { isCore: true, version: "10.0.48" }), pkg("nimbus.avado.dnp.dappnode.eth"), pkg("ethchain-geth.public.dappnode.eth")];

let server: http.Server;
let port = 0;
let care: CareService;

before(async () => {
  const config = testConfig({ checkNowCooldownMs: 0 });
  const f = fakeFetch((url) =>
    url.endsWith("/api/care/heartbeat") ? jsonResponse(200, { ok: true, subscribed: true, nextInSec: 600 }) : new Response("", { status: 404 }),
  );
  care = new CareService(
    config,
    silentLogger,
    { openWamp: () => new FakeWamp(dappmanagerHandlers(PACKAGES_OK)), fetch: f.fetch, now: () => Date.now(), store: new StateStore(config.stateDir, silentLogger) },
    emptyState(),
  );
  server = http.createServer(createApp(config, silentLogger, care));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  care.stop();
  server.close();
});

function request(pathname: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: opts.method ?? "GET", headers: { host: "care.my.ava.do", ...opts.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/status returns contract C", async () => {
  const r = await request("/api/status");
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body);
  for (const key of ["version", "lastHeartbeat", "verdict", "findings", "subscribed"]) assert.ok(key in s, key);
  assert.ok(!("remoteHelp" in s));
  assert.deepEqual(Object.keys(s.lastHeartbeat), ["at", "ok", "error"]);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("the Admin may read the status cross-origin; other origins get no CORS header", async () => {
  for (const origin of ["http://my.ava.do", "http://admin.my.ava.do"]) {
    const r = await request("/api/status", { headers: { origin } });
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
  }
  const evil = await request("/api/status", { headers: { origin: "http://evil.example" } });
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  assert.equal(isStatusCorsOrigin("http://my.ava.do.evil.com"), false);
  assert.equal(isStatusCorsOrigin("https://evilmy.ava.do"), false);
  assert.equal(isStatusCorsOrigin("http://evilmy.ava.do"), false);
});

test("POST /api/check-now needs the same-origin header and runs a check", async () => {
  const noHeader = await request("/api/check-now", { method: "POST" });
  assert.equal(noHeader.status, 403);
  const cross = await request("/api/check-now", { method: "POST", headers: { "x-avado-request": "1", origin: "http://my.ava.do" } });
  assert.equal(cross.status, 403, "the Admin cannot trigger it cross-origin");
  const ok = await request("/api/check-now", { method: "POST", headers: { "x-avado-request": "1", origin: "http://care.my.ava.do" } });
  assert.equal(ok.status, 200);
  const s = JSON.parse(ok.body);
  assert.equal(s.lastHeartbeat.ok, true);
  assert.equal(s.subscribed, true);
});

test("the API refuses foreign Host headers (DNS rebinding)", async () => {
  const r = await request("/api/status", { headers: { host: "attacker.example" } });
  assert.equal(r.status, 421);
  assert.equal(isAllowedHost("care.my.ava.do", ["care.my.ava.do"]), true);
  assert.equal(isAllowedHost("care.my.ava.do:8080", ["care.my.ava.do"]), false);
  assert.equal(isAllowedHost("192.168.1.20:80", []), true);
});

test("the remote-help routes do not exist", async () => {
  const r = await request("/api/remote-help/start", { method: "POST", headers: { "x-avado-request": "1" } });
  assert.equal(r.status, 404);
});

test("the status page is served with the CSP; nothing else on disk is", async () => {
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.equal(page.headers["content-security-policy"], PAGE_CSP);
  assert.match(page.body, /AVADO is watching your box/);
  for (const p of ["/app.js", "/style.css"]) assert.equal((await request(p)).status, 200, p);
  assert.equal((await request("/../package.json")).status, 404);
  assert.equal((await request("/%2e%2e/package.json")).status, 404);
  assert.equal((await request("/index.html", { method: "POST" })).status, 405);
});
