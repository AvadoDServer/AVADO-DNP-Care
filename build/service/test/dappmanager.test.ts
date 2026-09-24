import assert from "node:assert/strict";
import { test } from "node:test";
import { DappmanagerError, callDappmanager, fetchChainData, signCareRequest } from "../src/dappmanager.js";
import { FakeWamp, NODE_ID, SIGNATURE, envelope } from "./helpers.js";

const HASH = "a".repeat(64);

test("the envelope's result is returned; success:false becomes an error", async () => {
  const w = new FakeWamp({
    good: () => envelope([1, 2]),
    bad: () => JSON.stringify({ success: false, message: "nope" }),
  });
  assert.deepEqual(await callDappmanager(w, "good"), [1, 2]);
  await assert.rejects(callDappmanager(w, "bad"), /nope/);
  assert.equal(w.calls[0]!.procedure, "good.dappmanager.dnp.dappnode.eth");
});

test("signCareRequest sends exactly {action, timestamp, payloadHash} (contract A)", async () => {
  const w = new FakeWamp({
    signPrioritySupportRequest: (kw) => envelope({ nodeid: NODE_ID, timestamp: kw.timestamp, signature: SIGNATURE, action: kw.action, payloadHash: kw.payloadHash }),
  });
  const sig = await signCareRequest(w, "care-heartbeat", 1790000000, HASH);
  assert.deepEqual(sig, { nodeId: NODE_ID, timestamp: 1790000000, signature: SIGNATURE });
  assert.deepEqual(w.calls[0]!.kwargs, { action: "care-heartbeat", timestamp: 1790000000, payloadHash: HASH });
});

test("a DAPPMANAGER without the care actions is reported as 'outdated'", async () => {
  // 10.0.47 and older: only checkout and portal
  const old = new FakeWamp({
    signPrioritySupportRequest: () => JSON.stringify({ success: false, message: "kwarg action must be one of: checkout, portal" }),
  });
  await assert.rejects(signCareRequest(old, "care-heartbeat", 1, HASH), (e: unknown) => e instanceof DappmanagerError && e.kind === "outdated");

  // a signer that ignored the new kwargs and signed something else
  const ignoring = new FakeWamp({
    signPrioritySupportRequest: (kw) => envelope({ nodeid: NODE_ID, timestamp: kw.timestamp, signature: SIGNATURE, message: "..." }),
  });
  await assert.rejects(signCareRequest(ignoring, "care-heartbeat", 1, HASH), (e: unknown) => e instanceof DappmanagerError && e.kind === "outdated");
});

test("a signature over a different payload or time is refused", async () => {
  const wrongHash = new FakeWamp({
    signPrioritySupportRequest: (kw) => envelope({ nodeid: NODE_ID, timestamp: kw.timestamp, signature: SIGNATURE, action: kw.action, payloadHash: "b".repeat(64) }),
  });
  await assert.rejects(signCareRequest(wrongHash, "care-heartbeat", 5, HASH), /payload differs/);
  const wrongTs = new FakeWamp({
    signPrioritySupportRequest: (kw) => envelope({ nodeid: NODE_ID, timestamp: 6, signature: SIGNATURE, action: kw.action, payloadHash: kw.payloadHash }),
  });
  await assert.rejects(signCareRequest(wrongTs, "care-heartbeat", 5, HASH), /timestamp differs/);
  const badSig = new FakeWamp({
    signPrioritySupportRequest: (kw) => envelope({ nodeid: NODE_ID, timestamp: kw.timestamp, signature: "0x12", action: kw.action, payloadHash: kw.payloadHash }),
  });
  await assert.rejects(signCareRequest(badSig, "care-heartbeat", 5, HASH), /no signature/);
});

test("fetchChainData subscribes, requests, and returns the first published list", async () => {
  const w = new FakeWamp({}, [{ name: "Nimbus", syncing: false }]);
  assert.deepEqual(await fetchChainData(w), [{ name: "Nimbus", syncing: false }]);
  const silent = new FakeWamp({}, null);
  assert.equal(await fetchChainData(silent, 20), null);
});
