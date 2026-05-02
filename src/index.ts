import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, randomBytes } from "crypto";
import { tools } from "./tools.js";
import { isOAuthMode, buildAuthorizeUrl, exchangeCodeForTokens, getTenants } from "./xero-client.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SERVER_NAME = "dream-xero-mcp";
const SERVER_VERSION = "2.0.0";

// ─── Session Store ───────────────────────────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

// In-memory OAuth state store (state → expiresAt). Used for CSRF protection on /callback.
// In-memory is fine here because the OAuth handshake is < 5 minutes end-to-end.
const oauthStates = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function pruneOAuthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates) {
    if (expiresAt < now) oauthStates.delete(state);
  }
}

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of tools) {
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

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

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

// ─── OAuth Routes (only active when XERO_OAUTH_CLIENT_ID is set) ─────────────

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
    res.status(400).send(`<h1>Xero authorization error</h1><pre>${error}</pre>`);
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
          <p>To add another organisation, visit <a href="/auth/start">/auth/start</a> and select a different org from the Xero dropdown.</p>
          <p>Each new authorization is additive — Xero adds the org to your existing connections list.</p>
          <hr/>
          <p style="color: #666; font-size: 12px;">Token expires in ${result.expiresIn} seconds. Refresh tokens are stored in-memory and will survive until the next Railway redeploy.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OAuth callback error:", err);
    res.status(500).send(`<h1>Token exchange failed</h1><pre>${message}</pre>`);
  }
});

// GET /auth/status — quick way to see how many orgs are currently authorized.
app.get("/auth/status", async (_req: Request, res: Response) => {
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

// ─── MCP Endpoint (Streamable HTTP Transport) ────────────────────────────────

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
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
    } else {
      res.status(400).json({ error: "Bad request: missing or invalid session" });
      return;
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

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
  }
  res.status(204).send();
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  const mode = isOAuthMode() ? "OAuth (multi-tenant)" : "Custom Connection (single-tenant)";
  console.log(`✅ ${SERVER_NAME} v${SERVER_VERSION} listening on port ${PORT} — mode: ${mode}`);
  console.log(`   MCP endpoint:    /mcp`);
  console.log(`   Health check:    /health`);
  if (isOAuthMode()) {
    console.log(`   Auth start:      /auth/start`);
    console.log(`   Auth callback:   /callback`);
    console.log(`   Auth status:     /auth/status`);
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

export default app;
