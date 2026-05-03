import axios, { AxiosInstance } from "axios";
import {
  loadStoredToken,
  saveStoredToken,
  clearStoredToken,
  isPersistentStoreEnabled,
} from "./token-store.js";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

const DEFAULT_SCOPES = [
  "accounting.transactions",
  "accounting.transactions.read",
  "accounting.contacts",
  "accounting.contacts.read",
  "accounting.reports.read",
  "accounting.journals.read",
  "accounting.settings",
  "accounting.settings.read",
];

interface TokenCache {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

interface XeroTenant {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

export function isOAuthMode(): boolean {
  return Boolean(process.env.XERO_OAUTH_CLIENT_ID);
}

function getOAuthRedirectUri(): string {
  return (
    process.env.XERO_OAUTH_REDIRECT_URI ||
    "https://dream-xero-mcp-production.up.railway.app/callback"
  );
}

function getScopes(): string[] {
  if (process.env.XERO_SCOPES) {
    return process.env.XERO_SCOPES.split(/\s+/).filter(Boolean);
  }
  return isOAuthMode()
    ? ["offline_access", "openid", "profile", "email", ...DEFAULT_SCOPES]
    : DEFAULT_SCOPES;
}

let tokenCache: TokenCache | null = null;
let tokenLoadAttempted = false; // ensures we only hit the DB once per process

let tenantsCache: XeroTenant[] | null = null;
let tenantsCacheExpiresAt = 0;
let activeTenantId: string | null = null;

// Hydrate the in-memory token cache from the persistent store (Postgres) on
// first use. Called from getAccessToken so we don't slow down server startup
// and so the OAuth-mode-only behaviour stays predictable.
async function ensureTokenLoaded(): Promise<void> {
  if (tokenLoadAttempted || !isOAuthMode()) return;
  tokenLoadAttempted = true;
  if (!isPersistentStoreEnabled()) return;
  const stored = await loadStoredToken();
  if (stored) {
    tokenCache = {
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      refreshToken: stored.refreshToken,
    };
    console.log("✅ Loaded refresh token from persistent store");
  }
}

async function persistCurrentToken(): Promise<void> {
  if (!isPersistentStoreEnabled()) return;
  if (!tokenCache?.refreshToken) return;
  await saveStoredToken({
    accessToken: tokenCache.accessToken,
    refreshToken: tokenCache.refreshToken,
    expiresAt: tokenCache.expiresAt,
  });
}


async function fetchCustomConnectionToken(): Promise<string> {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Custom Connection requires XERO_CLIENT_ID and XERO_CLIENT_SECRET.");
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: DEFAULT_SCOPES.join(" "),
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  const { access_token, expires_in } = response.data;
  tokenCache = { accessToken: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  return access_token;
}

export function buildAuthorizeUrl(state: string): string {
  const clientId = process.env.XERO_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error("XERO_OAUTH_CLIENT_ID is not set.");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(),
    scope: getScopes().join(" "),
    state,
  });
  return `${XERO_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantCount: number;
}> {
  const clientId = process.env.XERO_OAUTH_CLIENT_ID;
  const clientSecret = process.env.XERO_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth requires XERO_OAUTH_CLIENT_ID and XERO_OAUTH_CLIENT_SECRET.");
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getOAuthRedirectUri(),
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  const { access_token, refresh_token, expires_in } = response.data;
  tokenCache = {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + (expires_in - 60) * 1000,
  };
  await persistCurrentToken();
  // Force-refresh tenant list now that we have a fresh OAuth token
  tenantsCache = null;
  tenantsCacheExpiresAt = 0;
  const tenants = await getTenants();
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
    tenantCount: tenants.length,
  };
}

async function refreshOAuthToken(): Promise<string> {
  const clientId = process.env.XERO_OAUTH_CLIENT_ID;
  const clientSecret = process.env.XERO_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth refresh requires XERO_OAUTH_CLIENT_ID and XERO_OAUTH_CLIENT_SECRET.");
  }
  if (!tokenCache?.refreshToken) {
    throw new Error("No OAuth refresh token. Visit /auth/start to authorize.");
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenCache.refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  const { access_token, refresh_token, expires_in } = response.data;
  tokenCache = {
    accessToken: access_token,
    refreshToken: refresh_token || tokenCache.refreshToken,
    expiresAt: Date.now() + (expires_in - 60) * 1000,
  };
  await persistCurrentToken();
  return access_token;
}

async function getAccessToken(): Promise<string> {
  await ensureTokenLoaded();
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.accessToken;
  if (isOAuthMode()) return refreshOAuthToken();
  return fetchCustomConnectionToken();
}

const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getTenants(): Promise<XeroTenant[]> {
  if (tenantsCache && Date.now() < tenantsCacheExpiresAt) return tenantsCache;
  const token = await getAccessToken();
  const response = await axios.get<XeroTenant[]>(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  tenantsCache = response.data;
  tenantsCacheExpiresAt = Date.now() + TENANT_CACHE_TTL_MS;
  if (!isOAuthMode() && tenantsCache.length > 0 && !activeTenantId) {
    activeTenantId = tenantsCache[0].tenantId;
  }
  return tenantsCache;
}

export function setActiveTenant(tenantId: string): void {
  activeTenantId = tenantId;
}

export function getActiveTenantId(): string | null {
  return activeTenantId;
}

async function resolveTenantId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (isOAuthMode()) {
    throw new Error("tenantId is required in OAuth mode. Use xero_list_organisations to see available tenants.");
  }
  if (activeTenantId) return activeTenantId;
  const tenants = await getTenants();
  if (tenants.length === 0) throw new Error("No Xero organisations connected.");
  activeTenantId = tenants[0].tenantId;
  return activeTenantId;
}

async function getApiClient(tenantId?: string): Promise<AxiosInstance> {
  const token = await getAccessToken();
  const tid = await resolveTenantId(tenantId);
  return axios.create({
    baseURL: XERO_API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": tid,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ─── Invoices ────────────────────────────────────────────────────────────────
export async function listInvoices(p: { tenantId?: string; status?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = ['Type=="ACCREC"'];
  if (p.status) where.push(`Status=="${p.status}"`);
  if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  if (where.length) query["where"] = where.join("&&");
  const response = await client.get("/Invoices", { params: query });
  return response.data.Invoices ?? [];
}

export async function getInvoice(invoiceIdOrNumber: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/Invoices/${invoiceIdOrNumber}`);
  return response.data.Invoices?.[0] ?? null;
}

// ─── Bills ───────────────────────────────────────────────────────────────────
export async function listBills(p: { tenantId?: string; status?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = ['Type=="ACCPAY"'];
  if (p.status) where.push(`Status=="${p.status}"`);
  if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  if (where.length) query["where"] = where.join("&&");
  const response = await client.get("/Invoices", { params: query });
  return response.data.Invoices ?? [];
}

// ─── Payments ────────────────────────────────────────────────────────────────
// Same unreconciledOnly + summary support as listBankTransactions.
// Critical accounting use case: payments applied to AR invoices or AP bills
// that look like normal cash events but were never matched to a real bank
// statement line. These are the "phantom paid" entries that misrepresent
// outstanding balances.
//
// Summary mode groups by PaymentType so you can see AR vs AP at a glance:
//   ACCRECPAYMENT  = payment received against a sales invoice
//   ACCPAYPAYMENT  = payment made against a supplier bill
//   ARCREDITPAYMENT / APCREDITPAYMENT = credit note refunds
//   AROVERPAYMENT  / APOVERPAYMENT  = overpayment refunds
//   ARPREPAYMENT   / APPREPAYMENT   = prepayments

const PAYMENTS_PAGE_SIZE = 100;
const PAYMENTS_MAX_PAGES_SAFETY = 50;

interface PaymentSummary {
  count: number;
  totalAmount: number;
  oldestDate: string | null;
  newestDate: string | null;
  byPaymentType: Array<{ paymentType: string; count: number; totalAmount: number }>;
  bankAccounts: Array<{ accountId: string; name: string; count: number; totalAmount: number }>;
}

// Per-call cache of AccountID → Name lookups (one Accounts API call per
// listPayments invocation, regardless of how many payments). Xero's /Payments
// often returns Account.AccountID + Account.Code but no Account.Name —
// especially for bank-account-targeted payments. Without enrichment the
// downstream UI shows "Unknown" for the bank account.
async function enrichAccountNames(
  client: AxiosInstance,
  payments: Array<{
    Account?: { AccountID?: string; Name?: string; Code?: string };
  }>
): Promise<void> {
  // Find AccountIDs we need to look up (have an ID but no Name)
  const idsNeedingLookup = new Set<string>();
  for (const p of payments) {
    const aid = p.Account?.AccountID;
    const aname = p.Account?.Name;
    if (aid && (!aname || aname === "")) idsNeedingLookup.add(aid);
  }
  if (idsNeedingLookup.size === 0) return;

  // Fetch all accounts once for this tenant. Cheap call (small response).
  let accounts: Array<{ AccountID?: string; Name?: string; Code?: string }> = [];
  try {
    const resp = await client.get("/Accounts");
    accounts = resp.data.Accounts ?? [];
  } catch (err) {
    // If lookup fails, just leave names blank — caller can still see AccountID
    console.error("enrichAccountNames: failed to fetch /Accounts", err);
    return;
  }

  // Build the lookup map
  const idToName = new Map<string, string>();
  for (const a of accounts) {
    if (a.AccountID && a.Name) idToName.set(a.AccountID, a.Name);
  }

  // Mutate each payment in place to fill in the Name
  for (const p of payments) {
    const aid = p.Account?.AccountID;
    if (!aid) continue;
    const name = idToName.get(aid);
    if (name && p.Account) p.Account.Name = name;
  }
}

export async function listPayments(p: {
  tenantId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  unreconciledOnly?: boolean;
  summary?: boolean;
  includeDeleted?: boolean;
}) {
  const client = await getApiClient(p.tenantId);
  const where: string[] = [];
  if (p.status) where.push(`Status=="${p.status}"`);
  if (p.unreconciledOnly) {
    where.push("IsReconciled==false");
    if (!p.includeDeleted) where.push('Status!="DELETED"');
  }
  if (p.dateFrom) where.push(`Date >= DateTime(${formatDateForWhere(p.dateFrom)})`);
  if (p.dateTo)   where.push(`Date <= DateTime(${formatDateForWhere(p.dateTo)})`);

  const baseParams: Record<string, string | number> = {};
  if (where.length) baseParams["where"] = where.join("&&");

  const fetchAll = async (): Promise<unknown[]> => {
    const all: unknown[] = [];
    for (let page = 1; page <= PAYMENTS_MAX_PAGES_SAFETY; page++) {
      const response = await client.get("/Payments", {
        params: { ...baseParams, page },
      });
      const batch: unknown[] = response.data.Payments ?? [];
      all.push(...batch);
      if (batch.length < PAYMENTS_PAGE_SIZE) break;
    }
    return all;
  };

  if (!p.unreconciledOnly && !p.summary) {
    const response = await client.get("/Payments", {
      params: { ...baseParams, page: p.page ?? 1 },
    });
    const fastResults = response.data.Payments ?? [];
    await enrichAccountNames(client, fastResults);
    return fastResults;
  }

  const payments = (await fetchAll()) as Array<{
    PaymentID?: string;
    Date?: string;
    Amount?: number;
    IsReconciled?: boolean;
    Status?: string;
    PaymentType?: string;
    Account?: { AccountID?: string; Name?: string; Code?: string };
  }>;

  const filtered = p.unreconciledOnly
    ? payments.filter((t) => t.IsReconciled === false &&
        (p.includeDeleted || t.Status !== "DELETED"))
    : payments;

  // Enrich Account.Name for any payment that has an AccountID but no Name.
  // Cheap (one /Accounts call per listPayments invocation, regardless of
  // payment count) and benefits both the !summary path (full records returned
  // to caller) and the summary path (bankAccounts[] in the aggregate).
  await enrichAccountNames(client, filtered);

  if (!p.summary) return filtered;

  const summary: PaymentSummary = {
    count: filtered.length,
    totalAmount: 0,
    oldestDate: null,
    newestDate: null,
    byPaymentType: [],
    bankAccounts: [],
  };
  const byType = new Map<string, { paymentType: string; count: number; totalAmount: number }>();
  const byAccount = new Map<string, { accountId: string; name: string; count: number; totalAmount: number }>();

  for (const t of filtered) {
    const amount = typeof t.Amount === "number" ? t.Amount : 0;
    summary.totalAmount += amount;
    const d = parseXeroDate(t.Date);
    if (d) {
      if (!summary.oldestDate || d < summary.oldestDate) summary.oldestDate = d;
      if (!summary.newestDate || d > summary.newestDate) summary.newestDate = d;
    }
    const pt = t.PaymentType ?? "UNKNOWN";
    const ptCur = byType.get(pt) ?? { paymentType: pt, count: 0, totalAmount: 0 };
    ptCur.count += 1;
    ptCur.totalAmount += amount;
    byType.set(pt, ptCur);
    const accId = t.Account?.AccountID ?? "unknown";
    const accName = t.Account?.Name ?? "Unknown";
    const acCur = byAccount.get(accId) ?? { accountId: accId, name: accName, count: 0, totalAmount: 0 };
    acCur.count += 1;
    acCur.totalAmount += amount;
    byAccount.set(accId, acCur);
  }

  summary.byPaymentType = Array.from(byType.values()).sort((a, b) => b.count - a.count);
  summary.bankAccounts = Array.from(byAccount.values()).sort((a, b) => b.count - a.count);
  summary.totalAmount = Math.round(summary.totalAmount * 100) / 100;
  for (const x of summary.byPaymentType) x.totalAmount = Math.round(x.totalAmount * 100) / 100;
  for (const x of summary.bankAccounts) x.totalAmount = Math.round(x.totalAmount * 100) / 100;
  return summary;
}

// ─── Bank Transactions ───────────────────────────────────────────────────────
// Supports two filtering modes:
//   - unreconciledOnly: when true, server fetches ALL pages, filters in-memory
//     to entries where IsReconciled === false, and returns just those.
//   - summary: when true, returns { count, totalAmount, oldestDate, newestDate,
//     bankAccounts: [{ name, count, totalAmount }] } instead of full transaction
//     objects. Massively cheaper in tokens for sweeping many clients.
// Both modes can be combined ("unreconciled summary across all clients").
const BANK_TXN_PAGE_SIZE = 100;
const MAX_PAGES_SAFETY = 50; // 5,000 txns per call max — guard against runaway

interface BankTxnSummary {
  count: number;
  totalAmount: number;
  oldestDate: string | null;
  newestDate: string | null;
  bankAccounts: Array<{ accountId: string; name: string; count: number; totalAmount: number }>;
}

export async function listBankTransactions(p: {
  tenantId?: string;
  bankAccountId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  unreconciledOnly?: boolean;
  summary?: boolean;
  includeDeleted?: boolean;
}) {
  const client = await getApiClient(p.tenantId);
  const where: string[] = [];
  if (p.bankAccountId) where.push(`BankAccount.AccountID=Guid("${p.bankAccountId}")`);
  if (p.status) where.push(`Status=="${p.status}"`);
  // Server-side filter for IsReconciled when supported. Xero's where syntax does
  // accept IsReconciled comparisons, so we push it down for efficiency.
  if (p.unreconciledOnly) {
    where.push("IsReconciled==false");
    // Voided/deleted bank txns can never reconcile by definition. Excluding
    // them prevents false positives in "find data quality issues" workflows
    // — UNLESS the caller explicitly wants them (includeDeleted=true), e.g.
    // for BAS review where seeing voided entries matters.
    if (!p.includeDeleted) where.push('Status!="DELETED"');
  }

  // Xero's /BankTransactions endpoint applies fromDate/toDate query params to
  // UpdatedDateUTC, NOT to the transaction's posting Date. To filter by the
  // actual transaction date we have to push it into the where clause.
  if (p.dateFrom) where.push(`Date >= DateTime(${formatDateForWhere(p.dateFrom)})`);
  if (p.dateTo)   where.push(`Date <= DateTime(${formatDateForWhere(p.dateTo)})`);

  const baseParams: Record<string, string | number> = {};
  if (where.length) baseParams["where"] = where.join("&&");

  // Paginated fetch helper — returns concatenated transactions across pages.
  // Only used when unreconciledOnly or summary is true (we want the full set
  // to filter or aggregate). Otherwise we honour the caller's page param.
  const fetchAll = async (): Promise<unknown[]> => {
    const all: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES_SAFETY; page++) {
      const response = await client.get("/BankTransactions", {
        params: { ...baseParams, page },
      });
      const batch: unknown[] = response.data.BankTransactions ?? [];
      all.push(...batch);
      if (batch.length < BANK_TXN_PAGE_SIZE) break;
    }
    return all;
  };

  // Fast path: no aggregation requested → single page like before.
  if (!p.unreconciledOnly && !p.summary) {
    const response = await client.get("/BankTransactions", {
      params: { ...baseParams, page: p.page ?? 1 },
    });
    return response.data.BankTransactions ?? [];
  }

  // Aggregating path: fetch all matching pages.
  const txns = (await fetchAll()) as Array<{
    BankTransactionID?: string;
    Date?: string;
    Total?: number;
    IsReconciled?: boolean;
    BankAccount?: { AccountID?: string; Name?: string };
  }>;

  // Belt-and-braces: even though we pushed IsReconciled==false to Xero, filter
  // again client-side in case Xero ignored the predicate for any reason.
  // Honour includeDeleted: drop DELETED only when caller didn't ask for them.
  const filtered = p.unreconciledOnly
    ? txns.filter((t) => t.IsReconciled === false &&
        (p.includeDeleted || (t as { Status?: string }).Status !== "DELETED"))
    : txns;

  if (!p.summary) return filtered;

  // Build summary
  const summary: BankTxnSummary = {
    count: filtered.length,
    totalAmount: 0,
    oldestDate: null,
    newestDate: null,
    bankAccounts: [],
  };
  const byAccount = new Map<string, { accountId: string; name: string; count: number; totalAmount: number }>();
  for (const t of filtered) {
    const amount = typeof t.Total === "number" ? t.Total : 0;
    summary.totalAmount += amount;
    // Xero dates come as "/Date(1234567890000+0000)/" — extract ms then ISO date
    const d = parseXeroDate(t.Date);
    if (d) {
      if (!summary.oldestDate || d < summary.oldestDate) summary.oldestDate = d;
      if (!summary.newestDate || d > summary.newestDate) summary.newestDate = d;
    }
    const accId = t.BankAccount?.AccountID ?? "unknown";
    const accName = t.BankAccount?.Name ?? "Unknown";
    const cur = byAccount.get(accId) ?? { accountId: accId, name: accName, count: 0, totalAmount: 0 };
    cur.count += 1;
    cur.totalAmount += amount;
    byAccount.set(accId, cur);
  }
  summary.bankAccounts = Array.from(byAccount.values()).sort((a, b) => b.count - a.count);
  // Round totals to 2dp for cleaner output
  summary.totalAmount = Math.round(summary.totalAmount * 100) / 100;
  for (const a of summary.bankAccounts) {
    a.totalAmount = Math.round(a.totalAmount * 100) / 100;
  }
  return summary;
}

// Format a YYYY-MM-DD string into Xero's where-clause DateTime literal: "YYYY,M,D"
function formatDateForWhere(isoDate: string): string {
  // isoDate expected as "YYYY-MM-DD". Be tolerant of extra chars.
  const m = isoDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return isoDate; // fall through; Xero will reject and surface the error
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  return `${year},${month},${day}`;
}

function parseXeroDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\/Date\((\d+)/);
  if (!match) return null;
  const ms = parseInt(match[1], 10);
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export async function listBankAccounts(tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get("/Accounts", { params: { where: 'Type=="BANK"' } });
  return response.data.Accounts ?? [];
}

// ─── Chart of Accounts ───────────────────────────────────────────────────────
export async function listAccounts(p: { tenantId?: string; type?: string; status?: string; }) {
  const client = await getApiClient(p.tenantId);
  const where: string[] = [];
  if (p.type) where.push(`Type=="${p.type}"`);
  if (p.status) where.push(`Status=="${p.status}"`);
  const query: Record<string, string> = {};
  if (where.length) query["where"] = where.join("&&");
  const response = await client.get("/Accounts", { params: query });
  return response.data.Accounts ?? [];
}

// ─── Journals ────────────────────────────────────────────────────────────────
export async function listJournals(p: { tenantId?: string; offset?: number; dateFrom?: string; dateTo?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = {};
  if (p.offset !== undefined) query["offset"] = p.offset;
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  const response = await client.get("/Journals", { params: query });
  return response.data.Journals ?? [];
}

// ─── Reports ─────────────────────────────────────────────────────────────────
export async function getProfitAndLoss(p: { tenantId?: string; fromDate?: string; toDate?: string; periods?: number; timeframe?: string; trackingCategoryID?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = {};
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  if (p.periods) query["periods"] = p.periods;
  if (p.timeframe) query["timeframe"] = p.timeframe;
  if (p.trackingCategoryID) query["trackingCategoryID"] = p.trackingCategoryID;
  const response = await client.get("/Reports/ProfitAndLoss", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getBalanceSheet(p: { tenantId?: string; date?: string; periods?: number; timeframe?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = {};
  if (p.date) query["date"] = p.date;
  if (p.periods) query["periods"] = p.periods;
  if (p.timeframe) query["timeframe"] = p.timeframe;
  const response = await client.get("/Reports/BalanceSheet", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getCashFlow(p: { tenantId?: string; fromDate?: string; toDate?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  const response = await client.get("/Reports/CashSummary", { params: query });
  return response.data.Reports?.[0] ?? null;
}

// ─── Contacts ────────────────────────────────────────────────────────────────
export async function listContacts(p: { tenantId?: string; name?: string; isSupplier?: boolean; isCustomer?: boolean; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = [];
  if (p.isSupplier !== undefined) where.push(`IsSupplier==${p.isSupplier}`);
  if (p.isCustomer !== undefined) where.push(`IsCustomer==${p.isCustomer}`);
  if (where.length) query["where"] = where.join("&&");
  if (p.name) query["searchTerm"] = p.name;
  const response = await client.get("/Contacts", { params: query });
  return response.data.Contacts ?? [];
}

export async function getContact(contactIdOrName: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/Contacts/${contactIdOrName}`);
  return response.data.Contacts?.[0] ?? null;
}

// ─── Credit Notes ────────────────────────────────────────────────────────────
export async function listCreditNotes(p: { tenantId?: string; status?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = [];
  if (p.status) where.push(`Status=="${p.status}"`);
  if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
  if (where.length) query["where"] = where.join("&&");
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  const response = await client.get("/CreditNotes", { params: query });
  return response.data.CreditNotes ?? [];
}

export async function getCreditNote(creditNoteIdOrNumber: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/CreditNotes/${creditNoteIdOrNumber}`);
  return response.data.CreditNotes?.[0] ?? null;
}

// ─── Quotes ──────────────────────────────────────────────────────────────────
export async function listQuotes(p: { tenantId?: string; status?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  if (p.status) query["status"] = p.status;
  if (p.contactId) query["ContactID"] = p.contactId;
  if (p.dateFrom) query["DateFrom"] = p.dateFrom;
  if (p.dateTo) query["DateTo"] = p.dateTo;
  const response = await client.get("/Quotes", { params: query });
  return response.data.Quotes ?? [];
}

export async function getQuote(quoteIdOrNumber: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/Quotes/${quoteIdOrNumber}`);
  return response.data.Quotes?.[0] ?? null;
}

// ─── Purchase Orders ─────────────────────────────────────────────────────────
export async function listPurchaseOrders(p: { tenantId?: string; status?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  if (p.status) query["status"] = p.status;
  if (p.dateFrom) query["DateFrom"] = p.dateFrom;
  if (p.dateTo) query["DateTo"] = p.dateTo;
  const response = await client.get("/PurchaseOrders", { params: query });
  return response.data.PurchaseOrders ?? [];
}

export async function getPurchaseOrder(purchaseOrderIdOrNumber: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/PurchaseOrders/${purchaseOrderIdOrNumber}`);
  return response.data.PurchaseOrders?.[0] ?? null;
}

// ─── Items ───────────────────────────────────────────────────────────────────
export async function listItems(p: { tenantId?: string; searchTerm?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.searchTerm) query["searchTerm"] = p.searchTerm;
  const response = await client.get("/Items", { params: query });
  return response.data.Items ?? [];
}

export async function getItem(itemIdOrCode: string, tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get(`/Items/${itemIdOrCode}`);
  return response.data.Items?.[0] ?? null;
}

// ─── Tracking Categories ─────────────────────────────────────────────────────
export async function listTrackingCategories(tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get("/TrackingCategories", { params: { includeArchived: false } });
  return response.data.TrackingCategories ?? [];
}

// ─── Tax Rates ───────────────────────────────────────────────────────────────
export async function listTaxRates(p: { tenantId?: string; taxType?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.taxType) query["where"] = `TaxType=="${p.taxType}"`;
  const response = await client.get("/TaxRates", { params: query });
  return response.data.TaxRates ?? [];
}

// ─── Manual Journals ─────────────────────────────────────────────────────────
export async function listManualJournals(p: { tenantId?: string; status?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = [];
  if (p.status) where.push(`Status=="${p.status}"`);
  if (where.length) query["where"] = where.join("&&");
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  const response = await client.get("/ManualJournals", { params: query });
  return response.data.ManualJournals ?? [];
}

// ─── Repeating Invoices ──────────────────────────────────────────────────────
export async function listRepeatingInvoices(p: { tenantId?: string; status?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.status) query["where"] = `Status=="${p.status}"`;
  const response = await client.get("/RepeatingInvoices", { params: query });
  return response.data.RepeatingInvoices ?? [];
}

// ─── Overpayments & Prepayments ──────────────────────────────────────────────
export async function listOverpayments(p: { tenantId?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = [];
  if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
  if (where.length) query["where"] = where.join("&&");
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  const response = await client.get("/Overpayments", { params: query });
  return response.data.Overpayments ?? [];
}

export async function listPrepayments(p: { tenantId?: string; contactId?: string; dateFrom?: string; dateTo?: string; page?: number; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1 };
  const where: string[] = [];
  if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
  if (where.length) query["where"] = where.join("&&");
  if (p.dateFrom) query["fromDate"] = p.dateFrom;
  if (p.dateTo) query["toDate"] = p.dateTo;
  const response = await client.get("/Prepayments", { params: query });
  return response.data.Prepayments ?? [];
}

// ─── Extended Reports ────────────────────────────────────────────────────────
export async function getAgedReceivables(p: { tenantId?: string; contactId?: string; date?: string; fromDate?: string; toDate?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.contactId) query["contactID"] = p.contactId;
  if (p.date) query["date"] = p.date;
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  const response = await client.get("/Reports/AgedReceivablesByContact", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getAgedPayables(p: { tenantId?: string; contactId?: string; date?: string; fromDate?: string; toDate?: string; }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.contactId) query["contactID"] = p.contactId;
  if (p.date) query["date"] = p.date;
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  const response = await client.get("/Reports/AgedPayablesByContact", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getTrialBalance(p: { tenantId?: string; date?: string; paymentsOnly?: boolean }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | boolean> = {};
  if (p.date) query["date"] = p.date;
  if (p.paymentsOnly !== undefined) query["paymentsOnly"] = p.paymentsOnly;
  const response = await client.get("/Reports/TrialBalance", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getExecutiveSummary(p: { tenantId?: string; date?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.date) query["date"] = p.date;
  const response = await client.get("/Reports/ExecutiveSummary", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getBankSummary(p: { tenantId?: string; fromDate?: string; toDate?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  const response = await client.get("/Reports/BankSummary", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getBudgetSummary(p: { tenantId?: string; date?: string; periods?: number; timeframe?: number }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string | number> = {};
  if (p.date) query["date"] = p.date;
  if (p.periods) query["periods"] = p.periods;
  if (p.timeframe) query["timeframe"] = p.timeframe;
  const response = await client.get("/Reports/BudgetSummary", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getGSTReport(p: { tenantId?: string; fromDate?: string; toDate?: string }) {
  const client = await getApiClient(p.tenantId);
  const query: Record<string, string> = {};
  if (p.fromDate) query["fromDate"] = p.fromDate;
  if (p.toDate) query["toDate"] = p.toDate;
  const response = await client.get("/Reports/GST", { params: query });
  return response.data.Reports?.[0] ?? null;
}

// ─── Fixed Assets ────────────────────────────────────────────────────────────
export async function listAssets(p: { tenantId?: string; status?: string; page?: number; pageSize?: number }) {
  const token = await getAccessToken();
  const tid = await resolveTenantId(p.tenantId);
  const query: Record<string, string | number> = { page: p.page ?? 1, pageSize: p.pageSize ?? 100 };
  if (p.status) query["status"] = p.status;
  const response = await axios.get("https://api.xero.com/assets.xro/1.0/Assets", {
    params: query,
    headers: { Authorization: `Bearer ${token}`, "xero-tenant-id": tid, Accept: "application/json" },
  });
  return response.data.items ?? response.data ?? [];
}

export async function getAssetSettings(tenantId?: string) {
  const token = await getAccessToken();
  const tid = await resolveTenantId(tenantId);
  const response = await axios.get("https://api.xero.com/assets.xro/1.0/Settings", {
    headers: { Authorization: `Bearer ${token}`, "xero-tenant-id": tid, Accept: "application/json" },
  });
  return response.data;
}

// ─── Misc ────────────────────────────────────────────────────────────────────
export async function listContactGroups(tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get("/ContactGroups");
  return response.data.ContactGroups ?? [];
}

export async function listCurrencies(tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get("/Currencies");
  return response.data.Currencies ?? [];
}

export async function getOrganisationDetails(tenantId?: string) {
  const client = await getApiClient(tenantId);
  const response = await client.get("/Organisation");
  return response.data.Organisations?.[0] ?? null;
}

// Re-export so callers can wipe stored tokens if needed (e.g. revocation flow)
export { clearStoredToken };
