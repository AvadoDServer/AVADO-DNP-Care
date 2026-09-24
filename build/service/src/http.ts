import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import type { CareService } from "./care.js";
import { isStatusCorsOrigin, type Config } from "./config.js";
import { checkCsrf, isSafeMethod } from "./csrf.js";
import { isAllowedHost } from "./host.js";
import { errorMessage, type Logger } from "./log.js";

/**
 * CSP for the status page. frame-ancestors lets only the AVADO Admin (my.ava.do) embed it.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' http://my.ava.do http://*.my.ava.do",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function sendJson(res: ServerResponse, statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

/**
 * The status page is a handful of static files: they are read once at start and served
 * from memory by exact name. Nothing else on disk is reachable.
 */
export function loadStaticFiles(dir: string): Map<string, { type: string; body: Buffer }> {
  const files = new Map<string, { type: string; body: Buffer }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const type = MIME[path.extname(name).toLowerCase()];
    if (!type || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    files.set(`/${name}`, { type, body: readFileSync(file) });
  }
  const index = files.get("/index.html");
  if (index) files.set("/", index);
  return files;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, files: Map<string, { type: string; body: Buffer }>): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  const file = files.get(pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": PAGE_CSP });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": file.type,
    "Content-Length": file.body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": PAGE_CSP,
  });
  res.end(req.method === "HEAD" ? undefined : file.body);
}

export function createApp(config: Config, logger: Logger, care: CareService): RequestListener {
  const files = loadStaticFiles(config.publicDir);

  return (req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        return sendError(res, 400, "Bad request");
      }
      const pathname = url.pathname;
      if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname, files);

      // DNS rebinding guard: the API only answers requests addressed to this box
      if (!isAllowedHost(req.headers.host, config.allowedHostnames)) {
        logger.warn(`${req.method} ${pathname} refused: Host not allowed`);
        return sendError(res, 421, "This page only answers requests addressed to your AVADO");
      }
      // every state-changing request must come from the status page itself
      const csrf = checkCsrf(req);
      if (csrf) {
        logger.warn(`${req.method} ${pathname} refused: ${csrf}`);
        return sendError(res, 403, csrf);
      }

      if (pathname === "/api/status") {
        if (!isSafeMethod(req.method)) {
          res.setHeader("Allow", "GET, HEAD");
          return sendError(res, 405, "Use GET for this route");
        }
        // The AVADO Admin reads this status through its own proxy, or cross-origin from
        // http(s)://my.ava.do as a fallback; it is read-only and shows nothing the Admin does not.
        const origin = req.headers.origin;
        const cors: Record<string, string> =
          typeof origin === "string" && isStatusCorsOrigin(origin)
            ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
            : { Vary: "Origin" };
        return sendJson(res, 200, care.status(), cors);
      }

      if (pathname === "/api/check-now") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return sendError(res, 405, "Use POST for this route");
        }
        const r = await care.checkNow();
        if (!r.ran) return sendError(res, 429, "A check just ran. Please wait a minute and try again.");
        logger.info(r.done ? "check-now: done" : "check-now: still running");
        // when the check is still running, status().checking is true and the page keeps polling
        return sendJson(res, 200, care.status());
      }

      return sendError(res, 404, "Unknown API route");
    })().catch((err: unknown) => {
      logger.error(`request failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}
