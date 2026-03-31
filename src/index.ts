import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { tools } from "./tools.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SERVER_NAME = "dream-xero-mcp";
const SERVER_VERSION = "1.0.0";

// ─── Session Store (stateful transport for SSE) ──────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tools
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      // Convert Zod schema to JSON Schema shape that the SDK expects
      (tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {},
      async (params: Record<string, unknown>) => {
        try {
          const result = await tool.handler(params);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${message}`,
              },
            ],
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
    timestamp: new Date().toISOString(),
  });
});

// OAuth callback stub — required env var but custom connections don't use redirects.
// Included for completeness / future standard OAuth support.
app.get("/callback", (req: Request, res: Response) => {
  res.json({
    message:
      "Xero OAuth callback received. Custom connections use client_credentials and do not require an interactive redirect flow.",
    query: req.query,
  });
});

// ─── MCP Endpoint (Streamable HTTP Transport) ────────────────────────────────

// POST /mcp — handles new sessions and subsequent messages
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session
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
      res.status(400).json({
        error: "Bad request: missing or invalid session",
      });
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

// GET /mcp — SSE stream for server-to-client notifications
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close session
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
  console.log(`✅ ${SERVER_NAME} v${SERVER_VERSION} listening on port ${PORT}`);
  console.log(`   MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`   Health check: http://0.0.0.0:${PORT}/health`);

  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    console.warn(
      "⚠️  WARNING: XERO_CLIENT_ID and/or XERO_CLIENT_SECRET are not set. Xero API calls will fail."
    );
  }
});

export default app;
