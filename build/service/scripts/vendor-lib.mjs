// Shared by vendor-sync.mjs, vendor-build.mjs and test/vendor-sync.test.ts.
//
// The Care package runs the AVADO Admin's own health rules. The files listed in
// VENDORED_FILES are byte-for-byte copies of DNP_ADMIN/build/src/src/<path>,
// kept in vendor/admin/<path>. vendor/admin/VENDORED.json records the sha256 of
// each copy and the Admin commit it came from.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Paths relative to DNP_ADMIN/build/src/src. fixActions.js is deliberately left out (it dispatches Admin UI actions). */
export const VENDORED_FILES = [
  "health/engine.js",
  "health/clients.js",
  "health/prometheus.js",
  "health/feeRecipients.js",
  "health/updateAges.js",
  "health/rules/index.js",
  "health/rules/access.js",
  "health/rules/apps.js",
  "health/rules/chain.js",
  "health/rules/core.js",
  "health/rules/setup.js",
  "health/rules/storage.js",
  "health/rules/updates.js",
  "health/rules/validators.js",
  "services/store/updates.js",
];

export const MANIFEST_NAME = "VENDORED.json";

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The service root (build/service), from the current working directory or a script location. */
export function serviceRoot() {
  return process.cwd();
}

export function vendorDir(root = serviceRoot()) {
  return path.join(root, "vendor", "admin");
}

/**
 * Where the Admin source lives: $ADMIN_SRC, else the sibling checkout
 * <GitHub>/DNP_ADMIN/build/src/src (this repo is <GitHub>/AVADO-DNP-Care).
 * Returns null when neither exists (e.g. inside the docker build).
 */
export function findAdminSrc(root = serviceRoot()) {
  const candidates = [process.env.ADMIN_SRC, path.resolve(root, "../../../DNP_ADMIN/build/src/src")].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(path.join(c, "health", "engine.js"))) return c;
  }
  return null;
}

export function readManifest(root = serviceRoot()) {
  return JSON.parse(readFileSync(path.join(vendorDir(root), MANIFEST_NAME), "utf8"));
}

/**
 * Differences between the vendored copies and an Admin source tree: changed or deleted files,
 * and rule files the Admin has that are not vendored. Empty when in sync.
 */
export function adminDivergence(admin, root = serviceRoot()) {
  const manifest = readManifest(root);
  const diverged = [];
  for (const rel of VENDORED_FILES) {
    const file = path.join(admin, rel);
    if (!existsSync(file)) diverged.push(`${rel} (deleted in the Admin)`);
    else if (sha256(readFileSync(file)) !== manifest.files[rel]) diverged.push(`${rel} (changed in the Admin)`);
  }
  const rulesDir = path.join(admin, "health", "rules");
  const adminRules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".js")) : [];
  for (const f of adminRules) {
    if (!VENDORED_FILES.includes(`health/rules/${f}`)) diverged.push(`health/rules/${f} (new in the Admin, not vendored)`);
  }
  return diverged;
}
