import axios, { AxiosInstance } from "axios";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

interface TokenCache {
  accessToken: string;
  expiresAt: number; // Unix ms timestamp
}

interface XeroTenant {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

let tokenCache: TokenCache | null = null;

// Active tenant chosen by user (defaults to first available)
let activeTenantId: string | null = null;
let tenantsCache: XeroTenant[] | null = null;

// ─── Token Management ────────────────────────────────────────────────────────

async function fetchAccessToken(): Promise<string> {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "XERO_CLIENT_ID and XERO_CLIENT_SECRET environment variables are required"
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: [
        "accounting.transactions",
        "accounting.transactions.read",
        "accounting.contacts",
        "accounting.contacts.read",
        "accounting.reports.read",
        "accounting.journals.read",
        "accounting.settings",
        "accounting.settings.read",
      ].join(" "),
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const { access_token, expires_in } = response.data;
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in - 60) * 1000, // 60s buffer
  };

  return access_token;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return fetchAccessToken();
}

// ─── Axios Instance Factory ──────────────────────────────────────────────────

async function getApiClient(tenantId?: string): Promise<AxiosInstance> {
  const token = await getAccessToken();
  const tid = tenantId || activeTenantId;

  if (!tid) {
    // Auto-discover and use first tenant
    const tenants = await getTenants();
    if (tenants.length === 0) {
      throw new Error(
        "No Xero organisations connected to this custom connection"
      );
    }
    activeTenantId = tenants[0].tenantId;
  }

  return axios.create({
    baseURL: XERO_API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": activeTenantId,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ─── Tenant / Organisation Tools ─────────────────────────────────────────────

export async function getTenants(): Promise<XeroTenant[]> {
  if (tenantsCache) return tenantsCache;

  const token = await getAccessToken();
  const response = await axios.get<XeroTenant[]>(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  tenantsCache = response.data;
  if (tenantsCache.length > 0 && !activeTenantId) {
    activeTenantId = tenantsCache[0].tenantId;
  }
  return tenantsCache;
}

export function setActiveTenant(tenantId: string): void {
  tenantsCache = null; // force refresh next time
  activeTenantId = tenantId;
}

export function getActiveTenantId(): string | null {
  return activeTenantId;
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export async function listInvoices(params: {
  status?: string;
  contactId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = { page: params.page ?? 1 };

  const where: string[] = ['Type=="ACCREC"'];
  if (params.status) where.push(`Status=="${params.status}"`);
  if (params.contactId)
    where.push(`Contact.ContactID=Guid("${params.contactId}")`);
  if (params.dateFrom) query["fromDate"] = params.dateFrom;
  if (params.dateTo) query["toDate"] = params.dateTo;
  if (where.length) query["where"] = where.join("&&");

  const response = await client.get("/Invoices", { params: query });
  return response.data.Invoices ?? [];
}

export async function getInvoice(invoiceIdOrNumber: string) {
  const client = await getApiClient();
  const response = await client.get(`/Invoices/${invoiceIdOrNumber}`);
  return response.data.Invoices?.[0] ?? null;
}

// ─── Bills (Accounts Payable) ────────────────────────────────────────────────

export async function listBills(params: {
  status?: string;
  contactId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = { page: params.page ?? 1 };

  const where: string[] = ['Type=="ACCPAY"'];
  if (params.status) where.push(`Status=="${params.status}"`);
  if (params.contactId)
    where.push(`Contact.ContactID=Guid("${params.contactId}")`);
  if (params.dateFrom) query["fromDate"] = params.dateFrom;
  if (params.dateTo) query["toDate"] = params.dateTo;
  if (where.length) query["where"] = where.join("&&");

  const response = await client.get("/Invoices", { params: query });
  return response.data.Invoices ?? [];
}

// ─── Payments ────────────────────────────────────────────────────────────────

export async function listPayments(params: {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = { page: params.page ?? 1 };

  const where: string[] = [];
  if (params.status) where.push(`Status=="${params.status}"`);
  if (where.length) query["where"] = where.join("&&");
  if (params.dateFrom) query["fromDate"] = params.dateFrom;
  if (params.dateTo) query["toDate"] = params.dateTo;

  const response = await client.get("/Payments", { params: query });
  return response.data.Payments ?? [];
}

// ─── Bank Transactions ───────────────────────────────────────────────────────

export async function listBankTransactions(params: {
  bankAccountId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = { page: params.page ?? 1 };

  const where: string[] = [];
  if (params.bankAccountId)
    where.push(`BankAccount.AccountID=Guid("${params.bankAccountId}")`);
  if (params.status) where.push(`Status=="${params.status}"`);
  if (where.length) query["where"] = where.join("&&");
  if (params.dateFrom) query["fromDate"] = params.dateFrom;
  if (params.dateTo) query["toDate"] = params.dateTo;

  const response = await client.get("/BankTransactions", { params: query });
  return response.data.BankTransactions ?? [];
}

export async function listBankAccounts() {
  const client = await getApiClient();
  const response = await client.get("/Accounts", {
    params: { where: 'Type=="BANK"' },
  });
  return response.data.Accounts ?? [];
}

// ─── Chart of Accounts ───────────────────────────────────────────────────────

export async function listAccounts(params: {
  type?: string;
  status?: string;
}) {
  const client = await getApiClient();
  const where: string[] = [];
  if (params.type) where.push(`Type=="${params.type}"`);
  if (params.status) where.push(`Status=="${params.status}"`);

  const query: Record<string, string> = {};
  if (where.length) query["where"] = where.join("&&");

  const response = await client.get("/Accounts", { params: query });
  return response.data.Accounts ?? [];
}

// ─── Journal Entries ─────────────────────────────────────────────────────────

export async function listJournals(params: {
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = {};
  if (params.offset !== undefined) query["offset"] = params.offset;
  if (params.dateFrom) query["fromDate"] = params.dateFrom;
  if (params.dateTo) query["toDate"] = params.dateTo;

  const response = await client.get("/Journals", { params: query });
  return response.data.Journals ?? [];
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export async function getProfitAndLoss(params: {
  fromDate?: string;
  toDate?: string;
  periods?: number;
  timeframe?: string;
  trackingCategoryID?: string;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = {};
  if (params.fromDate) query["fromDate"] = params.fromDate;
  if (params.toDate) query["toDate"] = params.toDate;
  if (params.periods) query["periods"] = params.periods;
  if (params.timeframe) query["timeframe"] = params.timeframe;
  if (params.trackingCategoryID)
    query["trackingCategoryID"] = params.trackingCategoryID;

  const response = await client.get("/Reports/ProfitAndLoss", {
    params: query,
  });
  return response.data.Reports?.[0] ?? null;
}

export async function getBalanceSheet(params: {
  date?: string;
  periods?: number;
  timeframe?: string;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = {};
  if (params.date) query["date"] = params.date;
  if (params.periods) query["periods"] = params.periods;
  if (params.timeframe) query["timeframe"] = params.timeframe;

  const response = await client.get("/Reports/BalanceSheet", { params: query });
  return response.data.Reports?.[0] ?? null;
}

export async function getCashFlow(params: {
  fromDate?: string;
  toDate?: string;
}) {
  const client = await getApiClient();
  const query: Record<string, string> = {};
  if (params.fromDate) query["fromDate"] = params.fromDate;
  if (params.toDate) query["toDate"] = params.toDate;

  const response = await client.get("/Reports/CashSummary", { params: query });
  return response.data.Reports?.[0] ?? null;
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function listContacts(params: {
  name?: string;
  isSupplier?: boolean;
  isCustomer?: boolean;
  page?: number;
}) {
  const client = await getApiClient();
  const query: Record<string, string | number> = { page: params.page ?? 1 };

  const where: string[] = [];
  if (params.isSupplier !== undefined)
    where.push(`IsSupplier==${params.isSupplier}`);
  if (params.isCustomer !== undefined)
    where.push(`IsCustomer==${params.isCustomer}`);
  if (where.length) query["where"] = where.join("&&");
  if (params.name) query["searchTerm"] = params.name;

  const response = await client.get("/Contacts", { params: query });
  return response.data.Contacts ?? [];
}

export async function getContact(contactIdOrName: string) {
  const client = await getApiClient();
  const response = await client.get(`/Contacts/${contactIdOrName}`);
  return response.data.Contacts?.[0] ?? null;
}
