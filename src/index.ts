import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, randomBytes } from "crypto";
import { tools, writeTools } from "./tools.js";
import { isOAuthMode, buildAuthorizeUrl, exchangeCodeForTokens, getTenants } from "./xero-client.js";
import { checkMcpAuth, refuse, authMode, redactUrl } from "./mcp-auth.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SERVER_NAME = "dream-xero-mcp";
const SERVER_VERSION = "2.6.0";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of [...tools, ...writeTools]) {
    server.tool(
      tool.name,
      tool.description,
      (tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {},
      async (params: Record<string, unknown>) => {
        try {
          const result = await tool.handler(params);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

// ─── Session errors ──────────────────────────────────────────────────────────
// Sessions live in memory, so a redeploy forgets them. Per the Streamable HTTP
// spec an unknown session ID gets 404, which tells the client to start a new
// session; 400 is kept for requests that are malformed (no session ID at all).

function sessionNotFound(res: Response): void {
  res.status(404).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
}

function missingSession(res: Response): void {
  res.status(400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Bad request: mcp-session-id header is required (or send an initialize request)" },
  });
}

// ─── Express App ─────────────────────────────────────────────────────────────

/** Build the app. Each call has its own (empty) session store. */
export function createApp(): express.Express {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // In-memory OAuth state store (state → expiresAt). Used for CSRF protection on /callback.
  // In-memory is fine here because the OAuth handshake is < 5 minutes end-to-end.
  const oauthStates = new Map<string, number>();

  function pruneOAuthStates() {
    const now = Date.now();
    for (const [state, expiresAt] of oauthStates) {
      if (expiresAt < now) oauthStates.delete(state);
    }
  }

  const app = express();
  app.use(express.json());

  // One line per request. The URL is redacted: the key may be in it.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(`${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  // /mcp and /auth/status require MCP_API_KEY — see mcp-auth.ts. It may be an
  // x-api-key / Bearer header, ?key=, or the last path segment (/mcp/<key>).
  // /auth/start, /callback and /health stay open: Xero's OAuth flow and the
  // browser need them, and /callback is guarded by the one-time OAuth state.
  const guard: express.RequestHandler = (req, res, next) => {
    const key = req.params.key;
    const auth = checkMcpAuth(req, typeof key === "string" ? key : null);
    if (!auth.ok) { refuse(res, auth); return; }
    next();
  };

  const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      mode: isOAuthMode() ? "oauth" : "custom_connection",
      timestamp: new Date().toISOString(),
    });
  });

  // ─── OAuth Routes (only active when XERO_OAUTH_CLIENT_ID is set) ───────────

  // GET /auth/start — kicks off the Xero OAuth consent flow.
  // Visit this in a browser to grant the app access to a Xero org.
  // Repeat for each org you want to add (Xero requires one consent per org).
  app.get("/auth/start", (_req: Request, res: Response) => {
    if (!isOAuthMode()) {
      res.status(400).json({
        error: "OAuth mode is not enabled. Set XERO_OAUTH_CLIENT_ID and XERO_OAUTH_CLIENT_SECRET.",
      });
      return;
    }
    pruneOAuthStates();
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    try {
      const url = buildAuthorizeUrl(state);
      res.redirect(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /callback — Xero redirects here after consent.
  app.get("/callback", async (req: Request, res: Response) => {
    // In Custom Connection mode, /callback is a no-op stub.
    if (!isOAuthMode()) {
      res.json({
        message: "Xero OAuth callback received. Custom connections do not require an interactive redirect.",
        query: req.query,
      });
      return;
    }

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.status(400).send(`<h1>Xero authorization error</h1><pre>${escapeHtml(error)}</pre>`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("<h1>Missing code or state</h1>");
      return;
    }
    pruneOAuthStates();
    if (!oauthStates.has(state)) {
      res.status(400).send("<h1>Invalid or expired state</h1><p>Please start the auth flow again at /auth/start.</p>");
      return;
    }
    oauthStates.delete(state);

    try {
      const result = await exchangeCodeForTokens(code);
      res.send(`
        <html>
          <head><title>Dream Xero MCP — Authorization Complete</title></head>
          <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px;">
            <h1>✅ Authorization successful</h1>
            <p>This OAuth app now has access to <strong>${result.tenantCount}</strong> Xero organisation(s).</p>
            <p>To add another organisation, visit /auth/start again and select a different org from the Xero dropdown.</p>
            <p>Each new authorization is additive — Xero adds the org to your existing connections list.</p>
            <hr/>
            <p style="color: #666; font-size: 12px;">Token expires in ${result.expiresIn} seconds. Refresh tokens are stored in-memory and will survive until the next Railway redeploy.</p>
          </body>
        </html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("OAuth callback error:", err);
      res.status(500).send(`<h1>Token exchange failed</h1><pre>${escapeHtml(message)}</pre>`);
    }
  });

  // GET /auth/status — quick way to see how many orgs are currently authorized.
  app.get(["/auth/status", "/auth/status/:key"], guard, async (_req: Request, res: Response) => {
    try {
      const tenants = await getTenants();
      res.json({
        mode: isOAuthMode() ? "oauth" : "custom_connection",
        tenantCount: tenants.length,
        tenants: tenants.map((t) => ({
          tenantId: t.tenantId,
          tenantName: t.tenantName,
          tenantType: t.tenantType,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: message,
        hint: isOAuthMode()
          ? "If you see 'No OAuth refresh token', visit /auth/start to authorize the app."
          : "Check XERO_CLIENT_ID and XERO_CLIENT_SECRET are set correctly.",
      });
    }
  });

  // ─── MCP Endpoint (Streamable HTTP Transport) ──────────────────────────────

  app.post(["/mcp", "/mcp/:key"], guard, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (isInitializeRequest(req.body)) {
        // Always a new session, even if the client still sends an old ID
        // from before a redeploy.
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          transports.delete(newSessionId);
        };
        const server = createMcpServer();
        await server.connect(transport);
      } else if (!sessionId) {
        missingSession(res);
        return;
      } else if (!transports.has(sessionId)) {
        sessionNotFound(res);
        return;
      } else {
        transport = transports.get(sessionId)!;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  });

  app.get(["/mcp", "/mcp/:key"], guard, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) { missingSession(res); return; }
    const transport = transports.get(sessionId);
    if (!transport) { sessionNotFound(res); return; }
    await transport.handleRequest(req, res);
  });

  app.delete(["/mcp", "/mcp/:key"], guard, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) { missingSession(res); return; }
    const transport = transports.get(sessionId);
    if (!transport) { sessionNotFound(res); return; }
    await transport.close();
    transports.delete(sessionId);
    res.status(204).send();
  });

  return app;
}

// ─── Start Server ─────────────────────────────────────────────────────────────

if (require.main === module) {
  createApp().listen(PORT, "0.0.0.0", () => {
    const mode = isOAuthMode() ? "OAuth (multi-tenant)" : "Custom Connection (single-tenant)";
    console.log(`✅ ${SERVER_NAME} v${SERVER_VERSION} listening on port ${PORT} — mode: ${mode}`);
    console.log(`   MCP endpoint:    /mcp`);
    console.log(`   MCP auth:        ${authMode()}`);
    console.log(`   Health check:    /health`);
    if (isOAuthMode()) {
      console.log(`   Auth start:      /auth/start`);
      console.log(`   Auth callback:   /callback`);
      console.log(`   Auth status:     /auth/status`);
    }
    if (!process.env.MCP_API_KEY) {
      console.error("❌ ERROR: MCP_API_KEY is not set. /mcp and /auth/status will return 503 until it is set in Railway's Variables tab.");
    }
    if (process.env.MCP_ACCESS_TOKEN) {
      console.warn("⚠️  WARNING: MCP_ACCESS_TOKEN is no longer used — the variable is now MCP_API_KEY.");
    }
    if (isOAuthMode()) {
      if (!process.env.XERO_OAUTH_CLIENT_SECRET) {
        console.warn("⚠️  WARNING: XERO_OAUTH_CLIENT_SECRET is not set. OAuth will fail.");
      }
    } else {
      if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
        console.warn("⚠️  WARNING: XERO_CLIENT_ID and/or XERO_CLIENT_SECRET are not set.");
      }
    }
  });
}
