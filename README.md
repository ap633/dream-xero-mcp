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

## Write tools

These are available to every client with the key, alongside the read tools.

| Tool | What it does |
|---|---|
| `xero_create_manual_journal` | Creates a **draft** manual journal. Lines take a `debit` or a `credit`; with `NoTax` (the default) the journal must balance or it's rejected before reaching Xero. Never posts: someone reviews and posts it in Xero. |
| `xero_create_contra_invoice` | Creates and **approves** a nil-total contra invoice for a monthly-package client (see below). `preview: true` checks everything without creating it. |

Each write is logged, e.g. `WRITE contra invoice INV-123 (PAID) for "<contact>" in "<organisation>"`.

## Monthly packages: income in advance and contras

Monthly package invoices put fees, with GST, into Income in Advance accounts: **804.YY** Tax, **805.YY** Strategy, **806.YY** BAS & BK, where YY is the financial year the work belongs to, or **804.5** Other for lump sums. When a job goes to OFS, a **contra invoice** to the same contact moves the ex-GST fee to income, with **BAS Excluded** on every line, because the GST was already reported on the monthly invoices.

`xero_create_contra_invoice`:
- sets the income account from the Income in Advance account (804.YY→200, 805.YY→204, 806.YY→202). 804.5 Other needs `incomeAccount`, which can be any income account.
- uses BAS Excluded on every line, so the total is nil and Xero marks it Paid when approved. It is not emailed.
- moves the job's full fee ex GST. If that's more than the contact has been billed so far on that account, it's refused unless `aheadOfBilling: true`. That flag is for work done before all its instalments were invoiced, and the result shows the amount still to be invoiced.

`xero_prepaid_income_position` gives the position at any date (`asAt`), ex GST:

| Figure | Meaning |
|---|---|
| `prepaidIncomeLiability` | Clients in credit: fees billed for work not yet realised. The real liability. |
| `realisedAheadOfBilling` | Clients in debit who are still being invoiced (in the last two months): work done before its instalments were billed. A timing difference. |
| `debitsToReview` | Clients in debit who are no longer being invoiced on that account: not a timing difference, so most likely a contra that was too large, in the wrong year, or under a different contact. |
| `netPerBalanceSheet` | Xero's balance sheet figure, which nets all three. |
| `notFromInvoices` | The part of the balance sheet figure not explained by invoices, credit notes and contras: manual journals or opening balances. |

It's split by account, and with `includeClients` (or `contact`) by client.

`xero_income_in_advance_audit` reads sales invoices and credit notes (from 1 Jul 2022 by default) and reports:

| Issue | Severity |
|---|---|
| `contra_has_gst`: a contra line isn't BAS Excluded | error |
| `empty_contra`: a "contra" invoice with no amounts or accounts | error |
| `contra_wrong_income_account`: e.g. 806.YY moved to 200 instead of 202 | error |
| `over_reallocated`: more moved to income than was invoiced for that contact and account, and billing has stopped | warning |
| `realised_ahead_of_billing`: the same, but the contact is still being invoiced, so it's a timing difference | note |
| `possible_wrong_year`: Ignition's service text says another financial year, and that year's account exists | warning |
| `old_year_balance`: a balance left in an account three or more financial years old | warning |
| `contra_contact_has_no_monthly_invoice`: the contra is under a different contact from the monthly invoices (best practice is the same) | note |
| `monthly_line_straight_to_income`: a recent package invoice line coded straight to 200/202/204 | note |

It also returns the balance left per contact and account. Comparing those with the jobs realised at OFS (from the scheduling app) shows jobs whose contra hasn't been done. Manual journals into these accounts aren't included.

## Date filters

`dateFrom`/`dateTo` on the invoice, bill, credit note, manual journal, overpayment and prepayment lists are sent as a `where` clause on `Date`. Xero ignores `fromDate`/`toDate` query parameters on those endpoints. Before this fix the filters had no effect.

## Sessions and redeploys

MCP sessions are held in memory, so a redeploy forgets them. When a client sends an `mcp-session-id` the server doesn't recognise, it gets **404** (as the MCP Streamable HTTP spec says), and compliant clients start a new session automatically. An `initialize` request always creates a new session, even if it carries an old ID. **400** means the request had no session ID and wasn't an `initialize`.

## Development

```bash
npm install
npm run build
npm test
```

Tests use Node's built-in test runner. They start the app on a random port and don't call Xero or Postgres.
