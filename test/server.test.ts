import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createApp } from "../src/index.js";
import { resetAuthFailures, redactUrl } from "../src/mcp-auth.js";

const KEY = "test-key-0123456789abcdefghijklmnopqrstuvwxyz";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
};
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** Start a fresh app (empty session store) on a random port. */
async function start(): Promise<{ base: string; server: Server }> {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text };
}

let base: string;
let server: Server;
const quiet = console.log;

before(async () => {
  console.log = () => {}; // silence the per-request log line
  process.env.MCP_API_KEY = KEY;
  ({ base, server } = await start());
});
after(async () => {
  await stop(server);
  console.log = quiet;
});
beforeEach(() => {
  process.env.MCP_API_KEY = KEY;
  resetAuthFailures();
});

describe("API key on /mcp", () => {
  test("no key → 401", async () => {
    const r = await post(base, "/mcp", INITIALIZE);
    assert.equal(r.status, 401);
    assert.match(JSON.parse(r.text).error.message, /Unauthorized/);
  });

  test("wrong key → 401 (including a different length)", async () => {
    assert.equal((await post(base, "/mcp", INITIALIZE, { "x-api-key": "wrong" })).status, 401);
    assert.equal((await post(base, "/mcp", INITIALIZE, { "x-api-key": KEY.slice(0, -1) + "X" })).status, 401);
    assert.equal((await post(base, "/mcp?key=wrong", INITIALIZE)).status, 401);
  });

  test("x-api-key header → success", async () => {
    const r = await post(base, "/mcp", INITIALIZE, { "x-api-key": KEY });
    assert.equal(r.status, 200);
    assert.ok(r.sessionId);
  });

  test("Authorization: Bearer → success", async () => {
    const r = await post(base, "/mcp", INITIALIZE, { Authorization: `Bearer ${KEY}` });
    assert.equal(r.status, 200);
    assert.ok(r.sessionId);
  });

  test("?key= query string → success", async () => {
    const r = await post(base, `/mcp?key=${encodeURIComponent(KEY)}`, INITIALIZE);
    assert.equal(r.status, 200);
    assert.ok(r.sessionId);
  });

  test("/mcp/<key> path → success", async () => {
    const r = await post(base, `/mcp/${encodeURIComponent(KEY)}`, INITIALIZE);
    assert.equal(r.status, 200);
    assert.ok(r.sessionId);
  });

  test("GET and DELETE are protected too", async () => {
    assert.equal((await fetch(`${base}/mcp`)).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: "DELETE" })).status, 401);
  });

  test("MCP_API_KEY not set → 503 (fails closed)", async () => {
    delete process.env.MCP_API_KEY;
    assert.equal((await post(base, "/mcp", INITIALIZE)).status, 503);
    assert.equal((await post(base, "/mcp", INITIALIZE, { "x-api-key": KEY })).status, 503);
    assert.equal((await fetch(`${base}/auth/status`)).status, 503);
  });
});

describe("Sessions", () => {
  const auth = { "x-api-key": KEY };

  test("a known session works", async () => {
    const init = await post(base, "/mcp", INITIALIZE, auth);
    const r = await post(base, "/mcp", TOOLS_LIST, { ...auth, "mcp-session-id": init.sessionId! });
    assert.equal(r.status, 200);
    assert.match(r.text, /xero_/);
  });

  test("unknown session ID → 404 with a JSON-RPC body", async () => {
    const r = await post(base, "/mcp", TOOLS_LIST, { ...auth, "mcp-session-id": "no-such-session" });
    assert.equal(r.status, 404);
    const body = JSON.parse(r.text);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32001);
    const get = await fetch(`${base}/mcp`, { headers: { ...auth, "mcp-session-id": "no-such-session" } });
    assert.equal(get.status, 404);
    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { ...auth, "mcp-session-id": "no-such-session" } });
    assert.equal(del.status, 404);
  });

  test("non-initialize request with no session ID → 400", async () => {
    assert.equal((await post(base, "/mcp", TOOLS_LIST, auth)).status, 400);
    assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 400);
  });

  test("after a restart: old ID → 404, then initialize (even carrying the old ID) works", async () => {
    const first = await start();
    const init = await post(first.base, "/mcp", INITIALIZE, auth);
    assert.equal(init.status, 200);
    const oldId = init.sessionId!;
    await stop(first.server);

    const second = await start(); // same as a redeploy: empty session map
    try {
      const stale = await post(second.base, "/mcp", TOOLS_LIST, { ...auth, "mcp-session-id": oldId });
      assert.equal(stale.status, 404);

      const reinit = await post(second.base, "/mcp", INITIALIZE, { ...auth, "mcp-session-id": oldId });
      assert.equal(reinit.status, 200);
      assert.ok(reinit.sessionId);
      assert.notEqual(reinit.sessionId, oldId);

      const ok = await post(second.base, "/mcp", TOOLS_LIST, { ...auth, "mcp-session-id": reinit.sessionId! });
      assert.equal(ok.status, 200);
    } finally {
      await stop(second.server);
    }
  });
});

describe("Open routes", () => {
  test("/health is reachable without a key", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  test("/auth/start is reachable without a key", async () => {
    const r = await fetch(`${base}/auth/start`, { redirect: "manual" });
    assert.ok(![401, 503].includes(r.status), `got ${r.status}`);
  });

  test("/callback is reachable without a key", async () => {
    const r = await fetch(`${base}/callback`, { redirect: "manual" });
    assert.ok(![401, 503].includes(r.status), `got ${r.status}`);
  });

  test("/auth/status needs the key", async () => {
    assert.equal((await fetch(`${base}/auth/status`)).status, 401);
  });
});

describe("Log redaction", () => {
  test("key is removed from query and path", () => {
    assert.equal(redactUrl(`/mcp?key=${KEY}`), "/mcp?key=[REDACTED]");
    assert.equal(redactUrl(`/mcp?a=1&key=${KEY}&b=2`), "/mcp?a=1&key=[REDACTED]&b=2");
    assert.equal(redactUrl(`/mcp/${KEY}`), "/mcp/[REDACTED]");
    assert.equal(redactUrl(`/auth/status/${KEY}?x=1`), "/auth/status/[REDACTED]?x=1");
    assert.equal(redactUrl("/health"), "/health");
  });
});
