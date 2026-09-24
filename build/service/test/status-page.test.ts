/**
 * The status page (public/index.html + public/app.js) is plain, unbundled browser JS with no
 * test tooling of its own. This runs the real app.js in a small vm sandbox with a hand-rolled DOM
 * stub covering only what it touches, so the tests exercise the actual file a browser loads
 * rather than a re-implementation of its logic.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

class FakeElement {
  tagName: string;
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  children: FakeElement[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(tagName = "div") {
    this.tagName = tagName;
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | undefined {
    return this.attrs.get(name);
  }
  addEventListener(event: string, cb: () => void): void {
    const l = this.listeners.get(event) ?? [];
    l.push(cb);
    this.listeners.set(event, l);
  }
  click(): void {
    for (const cb of this.listeners.get("click") ?? []) cb();
  }
}

// Every element id app.js looks up (see public/index.html).
const ELEMENT_IDS = [
  "version",
  "headline",
  "subline",
  "verdict",
  "last-check",
  "next-check",
  "care",
  "subscription",
  "alerts-hint",
  "check-notice",
  "heartbeat-error",
  "check-now",
  "check-now-msg",
  "problems",
  "no-problems",
];

interface Harness {
  el: Map<string, FakeElement>;
  load(status: Record<string, unknown>): Promise<void>;
}

/** Loads the real public/app.js into a sandbox, fires DOMContentLoaded and lets it fetch /api/status once. */
function runAppJs(): Harness {
  const el = new Map<string, FakeElement>();
  for (const id of ELEMENT_IDS) el.set(id, new FakeElement());

  let domContentLoaded: (() => void) | null = null;
  let statusToServe: Record<string, unknown> = {};

  const documentStub = {
    documentElement: new FakeElement("html"),
    getElementById: (id: string) => el.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (event: string, cb: () => void) => {
      if (event === "DOMContentLoaded") domContentLoaded = cb;
    },
  };

  const sandbox: Record<string, unknown> = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false }) },
    location: { search: "" },
    URLSearchParams,
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn: () => void) => (fn(), 0),
    fetch: (url: string) => {
      assert.equal(url, "/api/status");
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statusToServe) });
    },
  };
  vm.createContext(sandbox);
  const src = readFileSync(path.resolve(process.cwd(), "public", "app.js"), "utf8");
  vm.runInContext(src, sandbox, { filename: "app.js" });

  assert.ok(domContentLoaded, "app.js did not register a DOMContentLoaded listener");

  return {
    el,
    async load(status) {
      statusToServe = status;
      domContentLoaded!();
      // flush the fetch().then(json).then(render) microtask chain
      await new Promise((r) => setImmediate(r));
    },
  };
}

const BASE_STATUS = {
  version: "0.1.0",
  lastHeartbeat: { at: null, ok: true, error: null },
  heartbeatIssue: null,
  verdict: "ok",
  findings: [],
  lastCheckAt: null,
  nextCheckAt: null,
  checking: false,
  notice: null,
};

test("the alerts-by-email footer hint is hidden once alerts by email are on", async () => {
  const h = runAppJs();
  await h.load({ ...BASE_STATUS, subscribed: true, emailVerified: true });
  assert.equal(h.el.get("subscription")!.textContent, "On");
  assert.equal(h.el.get("alerts-hint")!.hidden, true, "the hint should not repeat what the page already shows as On");
});

test("the alerts-by-email footer hint stays visible while alerts are not confirmed on", async () => {
  const h = runAppJs();

  await h.load({ ...BASE_STATUS, subscribed: true, emailVerified: false });
  assert.equal(h.el.get("subscription")!.textContent, "Confirm your email in the Admin under Priority");
  assert.equal(h.el.get("alerts-hint")!.hidden, false);

  await h.load({ ...BASE_STATUS, subscribed: false, emailVerified: null });
  assert.equal(h.el.get("subscription")!.textContent, "Off: turn on Priority Care in the Admin");
  assert.equal(h.el.get("alerts-hint")!.hidden, false);

  await h.load({ ...BASE_STATUS, subscribed: null, emailVerified: null });
  assert.equal(h.el.get("subscription")!.textContent, "Not known yet");
  assert.equal(h.el.get("alerts-hint")!.hidden, false);
});
