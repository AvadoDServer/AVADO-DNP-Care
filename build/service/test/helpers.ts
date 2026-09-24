import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { WampError, type EventHandler, type WampSession } from "../src/wamp.js";

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "avado-care-test-"));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      BACKEND_URL: "https://backend.test",
      STORE_RPC_URL: "https://rpc.test",
      IPFS_GATEWAY: "http://ipfs.test:8080/ipfs",
      IPFS_API: "http://ipfs.test:5001/api/v0",
      PACKAGE_VERSION: "0.1.0",
      STATE_DIR: tempDir(),
      PUBLIC_DIR: path.resolve(process.cwd(), "public"),
    }),
    ...overrides,
  };
}

export const NODE_ID = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
export const SIGNATURE = "0x" + "ab".repeat(65);

export const pkg = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  id: name,
  state: "running",
  running: true,
  isCore: false,
  version: "1.0.0",
  volumes: [],
  manifest: { name, title: name.split(".")[0], version: "1.0.0" },
  ...overrides,
});

export const envelope = (result: unknown) => JSON.stringify({ success: true, message: "ok", result });

export type Handler = (kwargs: Record<string, unknown>) => unknown;

/** A fake DAPPMANAGER over WAMP: procedures by short name, plus the chainData topic. */
export class FakeWamp implements WampSession {
  calls: Array<{ procedure: string; kwargs: Record<string, unknown> }> = [];
  closed = false;
  private subs = new Map<string, EventHandler>();

  constructor(
    public handlers: Record<string, Handler>,
    public chainData: unknown[] | null = [],
  ) {}

  async call(procedure: string, _args?: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ procedure, kwargs });
    const short = procedure.replace(".dappmanager.dnp.dappnode.eth", "");
    if (short === "requestChainData") {
      const data = this.chainData;
      if (data) setImmediate(() => this.subs.get("chainData.dappmanager.dnp.dappnode.eth")?.([data], {}));
      return envelope({ message: "ok" });
    }
    const h = this.handlers[short];
    if (!h) throw new WampError(`${procedure}: wamp.error.no_such_procedure`, "unavailable");
    return h(kwargs);
  }

  async subscribe(topic: string, handler: EventHandler): Promise<void> {
    this.subs.set(topic, handler);
  }

  close(): void {
    this.closed = true;
  }
}

/** A DAPPMANAGER with the care signing actions (contract A). */
export function dappmanagerHandlers(packages: unknown[], stats: Record<string, unknown> = { disk: "42%" }): Record<string, Handler> {
  return {
    listPackages: () => envelope(packages),
    getStats: () => envelope(stats),
    getParams: () => envelope({ nodeid: NODE_ID, ip: "85.84.83.82", internalip: "192.168.1.20", domain: "abc.dyndns.io", name: "AVADO" }),
    signPrioritySupportRequest: (kw) =>
      envelope({ nodeid: NODE_ID, timestamp: kw.timestamp, signature: SIGNATURE, action: kw.action, payloadHash: kw.payloadHash }),
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export function fakeFetch(route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return route(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
