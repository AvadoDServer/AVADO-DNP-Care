import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWED_HOSTNAMES } from "./host.js";

export interface Config {
  host: string;
  port: number;
  /** Priority Care backend (contract B). Care routes live under /api/care. */
  backendUrl: string;
  wampUrl: string;
  wampRealm: string;
  storeRpcUrl: string;
  ipfsGateway: string;
  ipfsApi: string;
  /** Holds state.json (last check and heartbeat) so the status page survives restarts. */
  stateDir: string;
  publicDir: string;
  /** Normal time between checks. The backend's nextInSec, when given, wins within [minIntervalMs, maxIntervalMs]. */
  intervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Delay before the first check after start, so the DAPPMANAGER is up after a reboot. */
  firstRunDelayMs: number;
  /** Shortest time between two "Check now" runs. */
  checkNowCooldownMs: number;
  /** How long to listen for a pushed chainData before asking the DAPPMANAGER to publish. */
  chainDataPushWaitMs: number;
  allowedHostnames: string[];
  version: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

function httpUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = (env[key] || fallback).trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${key} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`${key} must be an http(s) or ws(s) URL`);
  }
  return raw;
}

function readVersion(env: NodeJS.ProcessEnv): string {
  if (env.PACKAGE_VERSION) return env.PACKAGE_VERSION;
  for (const file of [env.PACKAGE_VERSION_FILE, "/usr/src/service/package-version"]) {
    if (!file) continue;
    try {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* not in the image (tests, local runs) */
    }
  }
  return "0.0.0-dev";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || "0.0.0.0",
    port: num(env, "PORT", 80),
    backendUrl: httpUrl(env, "BACKEND_URL", "https://priorityapi.ava.do"),
    wampUrl: httpUrl(env, "WAMP_URL", "ws://wamp.my.ava.do:8080/ws"),
    wampRealm: env.WAMP_REALM || "dappnode_admin",
    storeRpcUrl: httpUrl(env, "STORE_RPC_URL", "https://rpc.ava.do"),
    ipfsGateway: httpUrl(env, "IPFS_GATEWAY", "http://ipfs.my.ava.do:8080/ipfs"),
    ipfsApi: httpUrl(env, "IPFS_API", "http://ipfs.my.ava.do:5001/api/v0"),
    stateDir: env.STATE_DIR || "/data",
    publicDir: env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname,
    intervalMs: num(env, "INTERVAL_MS", 10 * 60 * 1000),
    minIntervalMs: num(env, "MIN_INTERVAL_MS", 5 * 60 * 1000),
    maxIntervalMs: num(env, "MAX_INTERVAL_MS", 60 * 60 * 1000),
    firstRunDelayMs: num(env, "FIRST_RUN_DELAY_MS", 30 * 1000),
    checkNowCooldownMs: num(env, "CHECK_NOW_COOLDOWN_MS", 60 * 1000),
    chainDataPushWaitMs: num(env, "CHAIN_DATA_PUSH_WAIT_MS", 6_000),
    allowedHostnames: [
      ...DEFAULT_ALLOWED_HOSTNAMES,
      ...(env.EXTRA_ALLOWED_HOSTNAMES || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ],
    version: readVersion(env),
  };
}

/**
 * Origins that may read GET /api/status cross-origin: exactly the AVADO Admin, http(s)://my.ava.do.
 * (Every installed package gets a <name>.my.ava.do name, so subdomains are not trusted.)
 * Read-only, no credentials; POSTs stay same-origin.
 */
export function isStatusCorsOrigin(origin: string | undefined): boolean {
  return origin === "http://my.ava.do" || origin === "https://my.ava.do";
}
