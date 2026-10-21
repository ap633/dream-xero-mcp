// -----------------------------------------------------------------------------
// API key protection for the MCP endpoint and /auth/status.
//
// The key is read from MCP_API_KEY and may arrive in any of:
//   x-api-key: <key>              Microsoft Copilot Studio
//   Authorization: Bearer <key>
//   ?key=<key>                    Claude.ai custom connector (URL only)
//   /mcp/<key>                    also URL only, kept for existing connectors
// Comparison is in constant time, and repeated failures from one address are
// throttled. If MCP_API_KEY is not set the protected routes fail closed (503).
//
// The key is read on every request rather than once at startup, so a missing
// variable shows up as 503 rather than an open server, and tests can set it.
// -----------------------------------------------------------------------------

import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

function apiKey(): string {
  return process.env.MCP_API_KEY ?? "";
}

export function authMode(): string {
  if (!apiKey()) return "NOT CONFIGURED — MCP_API_KEY is not set; /mcp and /auth/status will return 503";
  return "API key required";
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on unequal lengths, so check that first.
  return x.length === y.length && timingSafeEqual(x, y);
}

const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd ?? "").split(",")[0].trim();
  return first || req.socket.remoteAddress || "unknown";
}

function recentFailures(ip: string): number[] {
  const now = Date.now();
  const hits = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, hits);
  if (failures.size > 5000) failures.clear();
  return hits;
}

/** Forget throttled addresses (for tests). */
export function resetAuthFailures(): void {
  failures.clear();
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

/** The key the request supplied, from whichever place it used. */
function suppliedKey(req: IncomingMessage, pathKey: string | null): string {
  const header = first(req.headers["x-api-key"]);
  if (header) return header;
  const bearer = /^Bearer\s+(.+)$/i.exec(first(req.headers.authorization));
  if (bearer) return bearer[1].trim();
  const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("key");
  if (query) return query.trim();
  return (pathKey ?? "").trim();
}

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/** Decide whether a request may reach a protected route. */
export function checkMcpAuth(req: IncomingMessage, pathKey: string | null): AuthResult {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 503, message: "Server misconfigured: MCP_API_KEY is not set." };
  }

  const ip = clientIp(req);
  if (recentFailures(ip).length >= MAX_FAILURES) {
    return { ok: false, status: 429, message: "Too many failed attempts. Wait fifteen minutes and try again." };
  }

  const supplied = suppliedKey(req, pathKey);
  if (supplied && same(supplied, key)) return { ok: true };

  recentFailures(ip).push(Date.now());
  return {
    ok: false,
    status: 401,
    message: "Unauthorized: send the API key as \"x-api-key\", \"Authorization: Bearer\", or ?key=.",
  };
}

/** Write a JSON-RPC style refusal. */
export function refuse(res: { writeHead: (s: number, h: Record<string, string>) => unknown; end: (b: string) => unknown }, r: { status: number; message: string }): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (r.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="mcp"';
  res.writeHead(r.status, headers);
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: r.message } }));
}

/** A request URL safe to log: the key is removed from the query and the path. */
export function redactUrl(url: string | undefined): string {
  const [path, query] = String(url ?? "").split(/\?(.*)/s, 2);
  const safePath = path.replace(/^\/(mcp|auth\/start|auth\/status)\/[^/]+/, "/$1/[REDACTED]");
  if (query === undefined) return safePath;
  const safeQuery = query.replace(/(^|&)key=[^&]*/gi, "$1key=[REDACTED]");
  return `${safePath}?${safeQuery}`;
}
