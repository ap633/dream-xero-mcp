import { z } from "zod";
import * as xero from "./xero-client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown) => Promise<unknown>;
}

// Reusable: tenantId field used by every tool.
// In OAuth mode this is REQUIRED. In Custom Connection mode it's ignored
// (the single connected tenant is used automatically).
const tenantIdField = z
  .string()
  .optional()
  .describe(
    "Xero tenantId of the organisation to query. REQUIRED in OAuth mode (multi-tenant). Ignored in Custom Connection mode (single-tenant). Use xero_list_organisations to see available tenantIds."
  );

export const tools: ToolDefinition[] = [
  // ── Organisations ───────────────────────────────────────────────────────
  {
    name: "xero_list_organisations",
    description:
      "List all Xero organisations (tenants) accessible by this server. In OAuth mode returns ALL authorized orgs (potentially many). In Custom Connection mode returns the single connected org. Returns tenantId, tenantName, and tenantType.",
    inputSchema: z.object({}),
    handler: async () => {
      const tenants = await xero.getTenants();
      const activeId = xero.getActiveTenantId();
      return tenants.map((t) => ({
        tenantId: t.tenantId,
        tenantName: t.tenantName,
        tenantType: t.tenantType,
        isActive: t.tenantId === activeId,
      }));
    },
  },

  {
    name: "xero_switch_organisation",
    description:
      "Set the default Xero tenant for subsequent calls that omit tenantId. In OAuth mode this is mostly a convenience — you should still pass tenantId explicitly per call to avoid ambiguity across concurrent requests. Use xero_list_organisations first.",
    inputSchema: z.object({
      tenantId: z.string().describe("The Xero tenantId of the organisation to make active"),
    }),
    handler: async (input) => {
      const { tenantId } = input as { tenantId: string };
      xero.setActiveTenant(tenantId);
      return { success: true, activeTenantId: tenantId };
    },
  },

  // ── Invoices ─────────────────────────────────────────────────────────────
  {
    name: "xero_list_invoices",
    description: "List sales invoices (accounts receivable) from Xero. Filter by status, contact, date range. Paginated.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]).optional(),
      contactId: z.string().optional().describe("Filter by Xero Contact GUID"),
      dateFrom: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number (100 records per page)"),
    }),
    handler: async (input) => xero.listInvoices(input as Parameters<typeof xero.listInvoices>[0]),
  },

  {
    name: "xero_get_invoice",
    description: "Get a single Xero invoice by InvoiceID (GUID) or InvoiceNumber. Returns full details including line items and payments.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      invoiceIdOrNumber: z.string().describe("Xero InvoiceID (GUID) or InvoiceNumber (e.g. INV-0001)"),
    }),
    handler: async (input) => {
      const { invoiceIdOrNumber, tenantId } = input as { invoiceIdOrNumber: string; tenantId?: string };
      return xero.getInvoice(invoiceIdOrNumber, tenantId);
    },
  },

  // ── Bills ────────────────────────────────────────────────────────────────
  {
    name: "xero_list_bills",
    description: "List bills (accounts payable) from Xero. Filter by status, supplier, date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]).optional(),
      contactId: z.string().optional().describe("Filter by supplier Contact GUID"),
      dateFrom: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listBills(input as Parameters<typeof xero.listBills>[0]),
  },

  // ── Payments ─────────────────────────────────────────────────────────────
  {
    name: "xero_get_payments",
    description:
      "List payments from Xero. Same cost-saving modes as xero_list_bank_transactions: " +
      "(a) unreconciledOnly=true → server fetches all pages, returns ONLY unreconciled payments (IsReconciled==false AND Status!=DELETED). Surfaces 'phantom paid' entries — invoices/bills marked as paid that were never matched to a real bank statement line. " +
      "(b) summary=true → returns aggregate {count, totalAmount, oldestDate, newestDate, byPaymentType[], bankAccounts[]}. byPaymentType lets you split AR (ACCRECPAYMENT) vs AP (ACCPAYPAYMENT) vs credits/overpayments. " +
      "Combine for cheap multi-tenant 'phantom payment sweep' workflows. " +
      "When neither mode is set, behaves like a normal paginated list.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.enum(["AUTHORISED", "DELETED"]).optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1).describe("Page number (100 per page). Ignored when unreconciledOnly or summary is true (server fetches all pages)."),
      unreconciledOnly: z.boolean().optional().describe("If true, return only entries with IsReconciled==false (excluding DELETED)."),
      summary: z.boolean().optional().describe("If true, return aggregate counts/totals grouped by PaymentType and bank account. Massively cheaper in tokens."),
    }),
    handler: async (input) => xero.listPayments(input as Parameters<typeof xero.listPayments>[0]),
  },

  // ── Bank Transactions ────────────────────────────────────────────────────
  {
    name: "xero_list_bank_transactions",
    description:
      "List bank transactions (spend money / receive money) from Xero. " +
      "Two cost-saving modes: " +
      "(a) unreconciledOnly=true → server fetches all pages, returns ONLY unreconciled entries (IsReconciled==false). Useful for surfacing data-quality issues. " +
      "(b) summary=true → returns aggregate {count, totalAmount, oldestDate, newestDate, bankAccounts[]} instead of full transaction details. Combine with unreconciledOnly for a cheap 'how many unreconciled per client' sweep across many tenants. " +
      "When neither mode is set, behaves like a normal paginated list.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      bankAccountId: z.string().optional().describe("Filter by bank Account GUID"),
      status: z.enum(["AUTHORISED", "DELETED"]).optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1).describe("Page number (100 per page). Ignored when unreconciledOnly or summary is true (server fetches all pages)."),
      unreconciledOnly: z.boolean().optional().describe("If true, return only entries with IsReconciled==false. Server auto-paginates."),
      summary: z.boolean().optional().describe("If true, return aggregate counts/totals per bank account instead of full transactions. Massively cheaper in tokens. Server auto-paginates."),
    }),
    handler: async (input) => xero.listBankTransactions(input as Parameters<typeof xero.listBankTransactions>[0]),
  },

  {
    name: "xero_list_bank_accounts",
    description: "List all bank accounts in the Xero organisation.",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.listBankAccounts((input as { tenantId?: string }).tenantId),
  },

  // ── Chart of Accounts ────────────────────────────────────────────────────
  {
    name: "xero_list_accounts",
    description: "List the Chart of Accounts. Filter by account type (BANK, CURRENT, EXPENSE, REVENUE, etc.) and status.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      type: z.string().optional().describe("Account type filter (e.g. BANK, REVENUE, EXPENSE)"),
      status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    }),
    handler: async (input) => xero.listAccounts(input as Parameters<typeof xero.listAccounts>[0]),
  },

  // ── Journals ─────────────────────────────────────────────────────────────
  {
    name: "xero_list_journal_entries",
    description: "List general ledger journal entries from Xero. Use offset for pagination.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      offset: z.number().int().optional().describe("Journal number offset for pagination"),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }),
    handler: async (input) => xero.listJournals(input as Parameters<typeof xero.listJournals>[0]),
  },

  // ── Reports ──────────────────────────────────────────────────────────────
  {
    name: "xero_get_profit_and_loss",
    description: "Profit & Loss report for a date range. Optionally include comparison periods.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
      periods: z.number().int().optional(),
      timeframe: z.enum(["MONTH", "QUARTER", "YEAR"]).optional(),
      trackingCategoryID: z.string().optional(),
    }),
    handler: async (input) => xero.getProfitAndLoss(input as Parameters<typeof xero.getProfitAndLoss>[0]),
  },

  {
    name: "xero_get_balance_sheet",
    description: "Balance Sheet as at a specified date.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      date: z.string().optional(),
      periods: z.number().int().optional(),
      timeframe: z.enum(["MONTH", "QUARTER", "YEAR"]).optional(),
    }),
    handler: async (input) => xero.getBalanceSheet(input as Parameters<typeof xero.getBalanceSheet>[0]),
  },

  {
    name: "xero_get_cash_flow",
    description: "Cash Summary report for a date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    }),
    handler: async (input) => xero.getCashFlow(input as Parameters<typeof xero.getCashFlow>[0]),
  },

  // ── Contacts ─────────────────────────────────────────────────────────────
  {
    name: "xero_list_contacts",
    description: "List Xero contacts. Filter by name, supplier flag, customer flag.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      name: z.string().optional().describe("Search term for contact name"),
      isSupplier: z.boolean().optional(),
      isCustomer: z.boolean().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listContacts(input as Parameters<typeof xero.listContacts>[0]),
  },

  {
    name: "xero_get_contact",
    description: "Get a single contact by ContactID (GUID) or exact name.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactIdOrName: z.string(),
    }),
    handler: async (input) => {
      const { contactIdOrName, tenantId } = input as { contactIdOrName: string; tenantId?: string };
      return xero.getContact(contactIdOrName, tenantId);
    },
  },

  // ── Credit Notes ─────────────────────────────────────────────────────────
  {
    name: "xero_list_credit_notes",
    description: "List credit notes. Filter by status, contact, date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.string().optional(),
      contactId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listCreditNotes(input as Parameters<typeof xero.listCreditNotes>[0]),
  },

  {
    name: "xero_get_credit_note",
    description: "Get a single credit note by ID or number.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      creditNoteIdOrNumber: z.string(),
    }),
    handler: async (input) => {
      const { creditNoteIdOrNumber, tenantId } = input as { creditNoteIdOrNumber: string; tenantId?: string };
      return xero.getCreditNote(creditNoteIdOrNumber, tenantId);
    },
  },

  // ── Quotes ───────────────────────────────────────────────────────────────
  {
    name: "xero_list_quotes",
    description: "List quotes. Filter by status, contact, date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.string().optional(),
      contactId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listQuotes(input as Parameters<typeof xero.listQuotes>[0]),
  },

  {
    name: "xero_get_quote",
    description: "Get a single quote by ID or number.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      quoteIdOrNumber: z.string(),
    }),
    handler: async (input) => {
      const { quoteIdOrNumber, tenantId } = input as { quoteIdOrNumber: string; tenantId?: string };
      return xero.getQuote(quoteIdOrNumber, tenantId);
    },
  },

  // ── Purchase Orders ──────────────────────────────────────────────────────
  {
    name: "xero_list_purchase_orders",
    description: "List purchase orders. Filter by status and date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listPurchaseOrders(input as Parameters<typeof xero.listPurchaseOrders>[0]),
  },

  {
    name: "xero_get_purchase_order",
    description: "Get a single purchase order by ID or number.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      purchaseOrderIdOrNumber: z.string(),
    }),
    handler: async (input) => {
      const { purchaseOrderIdOrNumber, tenantId } = input as { purchaseOrderIdOrNumber: string; tenantId?: string };
      return xero.getPurchaseOrder(purchaseOrderIdOrNumber, tenantId);
    },
  },

  // ── Items ────────────────────────────────────────────────────────────────
  {
    name: "xero_list_items",
    description: "List products & services (Items) from Xero.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      searchTerm: z.string().optional(),
    }),
    handler: async (input) => xero.listItems(input as Parameters<typeof xero.listItems>[0]),
  },

  {
    name: "xero_get_item",
    description: "Get a single Item by ItemID (GUID) or Code.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      itemIdOrCode: z.string(),
    }),
    handler: async (input) => {
      const { itemIdOrCode, tenantId } = input as { itemIdOrCode: string; tenantId?: string };
      return xero.getItem(itemIdOrCode, tenantId);
    },
  },

  // ── Tracking Categories ──────────────────────────────────────────────────
  {
    name: "xero_list_tracking_categories",
    description: "List active tracking categories (e.g. departments, locations).",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.listTrackingCategories((input as { tenantId?: string }).tenantId),
  },

  // ── Tax Rates ────────────────────────────────────────────────────────────
  {
    name: "xero_list_tax_rates",
    description: "List tax rates configured in the organisation.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      taxType: z.string().optional(),
    }),
    handler: async (input) => xero.listTaxRates(input as Parameters<typeof xero.listTaxRates>[0]),
  },

  // ── Manual Journals ──────────────────────────────────────────────────────
  {
    name: "xero_list_manual_journals",
    description: "List manual journals from Xero.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listManualJournals(input as Parameters<typeof xero.listManualJournals>[0]),
  },

  // ── Repeating Invoices ───────────────────────────────────────────────────
  {
    name: "xero_list_repeating_invoices",
    description: "List recurring/repeating invoice templates.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.string().optional(),
    }),
    handler: async (input) => xero.listRepeatingInvoices(input as Parameters<typeof xero.listRepeatingInvoices>[0]),
  },

  // ── Overpayments / Prepayments ───────────────────────────────────────────
  {
    name: "xero_list_overpayments",
    description: "List overpayments. Filter by contact and date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listOverpayments(input as Parameters<typeof xero.listOverpayments>[0]),
  },

  {
    name: "xero_list_prepayments",
    description: "List prepayments. Filter by contact and date range.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      page: z.number().int().min(1).default(1),
    }),
    handler: async (input) => xero.listPrepayments(input as Parameters<typeof xero.listPrepayments>[0]),
  },

  // ── Extended Reports ─────────────────────────────────────────────────────
  {
    name: "xero_get_aged_receivables",
    description: "Aged Receivables by Contact report. Critical for debtor management.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactId: z.string().optional(),
      date: z.string().optional(),
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    }),
    handler: async (input) => xero.getAgedReceivables(input as Parameters<typeof xero.getAgedReceivables>[0]),
  },

  {
    name: "xero_get_aged_payables",
    description: "Aged Payables by Contact report. Critical for creditor management.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactId: z.string().optional(),
      date: z.string().optional(),
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    }),
    handler: async (input) => xero.getAgedPayables(input as Parameters<typeof xero.getAgedPayables>[0]),
  },

  {
    name: "xero_get_trial_balance",
    description: "Trial Balance as at a specified date.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      date: z.string().optional(),
      paymentsOnly: z.boolean().optional(),
    }),
    handler: async (input) => xero.getTrialBalance(input as Parameters<typeof xero.getTrialBalance>[0]),
  },

  {
    name: "xero_get_executive_summary",
    description: "Executive Summary report — high-level business performance snapshot.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      date: z.string().optional(),
    }),
    handler: async (input) => xero.getExecutiveSummary(input as Parameters<typeof xero.getExecutiveSummary>[0]),
  },

  {
    name: "xero_get_bank_summary",
    description: "Bank Summary report — opening/closing balances and movements per bank account.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    }),
    handler: async (input) => xero.getBankSummary(input as Parameters<typeof xero.getBankSummary>[0]),
  },

  {
    name: "xero_get_budget_summary",
    description: "Budget Summary report comparing actuals to budget.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      date: z.string().optional(),
      periods: z.number().int().min(1).max(12).optional(),
      timeframe: z.number().int().optional().describe("Months per period (1=monthly, 3=quarterly, 12=annual)"),
    }),
    handler: async (input) => xero.getBudgetSummary(input as Parameters<typeof xero.getBudgetSummary>[0]),
  },

  {
    name: "xero_get_gst_report",
    description: "GST/BAS report for AU/NZ orgs.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    }),
    handler: async (input) => xero.getGSTReport(input as Parameters<typeof xero.getGSTReport>[0]),
  },

  // ── Fixed Assets ─────────────────────────────────────────────────────────
  {
    name: "xero_list_assets",
    description: "List fixed assets from the Xero Assets register.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      status: z.enum(["DRAFT", "REGISTERED", "DISPOSED"]).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(100),
    }),
    handler: async (input) => xero.listAssets(input as Parameters<typeof xero.listAssets>[0]),
  },

  {
    name: "xero_get_asset_settings",
    description: "Get default asset settings (depreciation accounts, etc.).",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.getAssetSettings((input as { tenantId?: string }).tenantId),
  },

  // ── Misc ─────────────────────────────────────────────────────────────────
  {
    name: "xero_list_contact_groups",
    description: "List contact groups.",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.listContactGroups((input as { tenantId?: string }).tenantId),
  },

  {
    name: "xero_list_currencies",
    description: "List currencies set up in the organisation.",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.listCurrencies((input as { tenantId?: string }).tenantId),
  },

  {
    name: "xero_get_organisation",
    description: "Get details about the Xero organisation (name, country, base currency, financial year, etc.).",
    inputSchema: z.object({ tenantId: tenantIdField }),
    handler: async (input) => xero.getOrganisationDetails((input as { tenantId?: string }).tenantId),
  },
];
