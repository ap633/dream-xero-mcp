# dream-xero-mcp

Xero MCP server for Dream Accounting. It exposes Xero accounting data as MCP tools over Streamable HTTP. It's deployed on Railway, and Xero OAuth tokens are stored in Postgres when `DATABASE_URL` is set.

## Routes

| Route | Key needed? | Purpose |
|---|---|---|
| `POST/GET/DELETE /mcp` | Yes | The MCP endpoint |
| `GET /auth/status` | Yes | Which Xero orgs are connected |
| `GET /auth/start` | No | Starts the Xero consent flow in a browser |
| `GET /callback` | No | Xero redirects here after consent (protected by a one-time state value) |
| `GET /health` | No | Railway health check |

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `MCP_API_KEY` | **Yes** | Shared secret for `/mcp` and `/auth/status`. If it isn't set, those routes return **503** and an error is logged at startup. |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Custom-connection mode | Single Xero org |
| `XERO_OAUTH_CLIENT_ID`, `XERO_OAUTH_CLIENT_SECRET`, `XERO_OAUTH_REDIRECT_URI` | OAuth mode | Many Xero orgs |
| `DATABASE_URL` | Recommended | Postgres, so Xero tokens survive redeploys |
| `XERO_SCOPES` | No | Override the default scopes |
| `PORT` | No | Set automatically by Railway |

Generate a key (32 random bytes, URL-safe):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put it in Railway → the service → **Variables** → `MCP_API_KEY`. Changing it means updating every client.

## How each client sends the key

The server accepts the key in any of these places:

| Client | How |
|---|---|
| Microsoft Copilot Studio | Header `x-api-key: <key>` (API key auth, header name `x-api-key`) |
| Other HTTP clients | Header `Authorization: Bearer <key>` |
| Claude.ai custom connector | URL only: `https://<host>/mcp?key=<key>` (or `https://<host>/mcp/<key>`) |
| Browser, for `/auth/status` | `https://<host>/auth/status?key=<key>` |

Use a header where the client allows it. A key in the URL can end up in proxy or platform logs, such as Railway's HTTP logs. The server's own request log redacts it, but logs it doesn't control won't.

A missing or wrong key gets **401**. After 20 failures from one address in 15 minutes, that address gets **429** for the rest of the window.

## Sessions and redeploys

MCP sessions are held in memory, so a redeploy forgets them. When a client sends an `mcp-session-id` the server doesn't recognise, it gets **404** (as the MCP Streamable HTTP spec says), and compliant clients start a new session automatically. An `initialize` request always creates a new session, even if it carries an old ID. **400** means the request had no session ID and wasn't an `initialize`.

## Development

```bash
npm install
npm run build
npm test
```

Tests use Node's built-in test runner. They start the app on a random port and don't call Xero or Postgres.
