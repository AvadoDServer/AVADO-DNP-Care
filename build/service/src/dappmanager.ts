/**
 * DAPPMANAGER procedures over WAMP. Each procedure returns a JSON string holding
 * `{success, message, result}`; `result` is used only when `success === true`.
 */
import { WampError, type WampSession } from "./wamp.js";

const SUFFIX = ".dappmanager.dnp.dappnode.eth";
export const CHAIN_DATA_TOPIC = `chainData${SUFFIX}`;

export class DappmanagerError extends Error {
  constructor(
    message: string,
    /** "outdated": the DAPPMANAGER does not know the care signing actions yet (needs a system update). */
    readonly kind: "unavailable" | "rejected" | "outdated",
  ) {
    super(message);
  }
}

export async function callDappmanager(wamp: WampSession, method: string, kwargs: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await wamp.call(`${method}${SUFFIX}`, [], kwargs, timeoutMs);
  } catch (e) {
    if (e instanceof WampError) throw new DappmanagerError(e.message, e.kind === "rejected" ? "rejected" : "unavailable");
    throw e;
  }
  let env: unknown = raw;
  if (typeof raw === "string") {
    try {
      env = JSON.parse(raw);
    } catch {
      throw new DappmanagerError(`${method}: the reply is not JSON`, "rejected");
    }
  }
  const { success, message, result } = (env ?? {}) as { success?: unknown; message?: unknown; result?: unknown };
  if (success !== true) throw new DappmanagerError(`${method}: ${typeof message === "string" ? message : "failed"}`, "rejected");
  return result;
}

export async function listPackages(wamp: WampSession): Promise<unknown[]> {
  // listPackages runs `docker system df`, which can take a while on a busy box
  const result = await callDappmanager(wamp, "listPackages", {}, 90_000);
  if (!Array.isArray(result)) throw new DappmanagerError("listPackages: the result is not a list", "rejected");
  return result;
}

export async function getStats(wamp: WampSession): Promise<Record<string, unknown>> {
  const result = await callDappmanager(wamp, "getStats");
  if (!result || typeof result !== "object") throw new DappmanagerError("getStats: no stats", "rejected");
  return result as Record<string, unknown>;
}

export async function getParams(wamp: WampSession): Promise<Record<string, unknown>> {
  const result = await callDappmanager(wamp, "getParams");
  if (!result || typeof result !== "object") throw new DappmanagerError("getParams: no params", "rejected");
  return result as Record<string, unknown>;
}

/**
 * chainData is pushed, not returned: subscribe to the DAPPMANAGER's topic, ask it to publish
 * (requestChainData publishes once right away), and take the first event. null when nothing
 * arrives in time (e.g. no chain packages are running).
 */
export async function fetchChainData(wamp: WampSession, waitMs = 15_000): Promise<unknown[] | null> {
  let resolveFirst!: (v: unknown[] | null) => void;
  const first = new Promise<unknown[] | null>((r) => (resolveFirst = r));
  await wamp.subscribe(CHAIN_DATA_TOPIC, (args) => {
    const data = args[0];
    if (Array.isArray(data)) resolveFirst(data);
  });
  await callDappmanager(wamp, "requestChainData");
  const timer = setTimeout(() => resolveFirst(null), waitMs);
  try {
    return await first;
  } finally {
    clearTimeout(timer);
  }
}

export type CareAction = "care-heartbeat" | "care-settings";

export interface CareSignature {
  nodeId: string;
  timestamp: number;
  signature: string;
}

/**
 * Contract A: asks the DAPPMANAGER to sign `{action, timestamp, payloadHash}` with the box
 * identity key. The key never leaves the DAPPMANAGER; only the signature comes back.
 */
export async function signCareRequest(wamp: WampSession, action: CareAction, timestamp: number, payloadHash: string): Promise<CareSignature> {
  let result: unknown;
  try {
    result = await callDappmanager(wamp, "signPrioritySupportRequest", { action, timestamp, payloadHash });
  } catch (e) {
    // A DAPPMANAGER from before the care actions answers "kwarg action must be one of: checkout, portal"
    if (e instanceof DappmanagerError && /must be one of/i.test(e.message) && !/care-heartbeat/.test(e.message)) {
      throw new DappmanagerError("signPrioritySupportRequest: this DAPPMANAGER cannot sign care requests yet", "outdated");
    }
    throw e;
  }
  const r = (result ?? {}) as Record<string, unknown>;
  const nodeId = typeof r.nodeid === "string" ? r.nodeid : "";
  const signature = typeof r.signature === "string" ? r.signature : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(nodeId)) throw new DappmanagerError("signPrioritySupportRequest: no node id in the reply", "rejected");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new DappmanagerError("signPrioritySupportRequest: no signature in the reply", "rejected");
  if (r.timestamp !== timestamp) throw new DappmanagerError("signPrioritySupportRequest: the signed timestamp differs", "rejected");
  if (r.action !== undefined && r.action !== action) throw new DappmanagerError("signPrioritySupportRequest: the signed action differs", "rejected");
  if (r.payloadHash !== undefined && r.payloadHash !== payloadHash) {
    throw new DappmanagerError("signPrioritySupportRequest: the signed payload differs", "rejected");
  }
  if (r.action === undefined || r.payloadHash === undefined) {
    // An old DAPPMANAGER that ignored the new kwargs would sign a checkout/portal-style message
    throw new DappmanagerError("signPrioritySupportRequest: this DAPPMANAGER cannot sign care requests yet", "outdated");
  }
  return { nodeId, timestamp, signature };
}
