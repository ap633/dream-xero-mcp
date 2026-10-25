import { z } from "zod";
import * as xero from "./xero-client.js";
import * as iia from "./income-in-advance.js";

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
      unreconciledOnly: z.boolean().optional().describe("If true, return only entries with IsReconciled==false. By default also excludes DELETED (set includeDeleted=true to keep them)."),
      summary: z.boolean().optional().describe("If true, return aggregate counts/totals grouped by PaymentType and bank account. Massively cheaper in tokens."),
      includeDeleted: z.boolean().optional().describe("If true, include voided (Status=DELETED) entries in the results. Default false. Useful for BAS review where seeing voided entries matters."),
      compactFields: z.boolean().optional().describe("If true, each payment is projected to a compact 15-field shape (PaymentID, Date, Amount, Status, PaymentType, AccountName, ContactName, InvoiceNumber, etc.) — ~70-80% smaller than the full Xero record. Strongly recommended for high-volume calls (>30 records) to avoid MCP response truncation. The IDs in the compact shape are sufficient for any follow-up lookups."),
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
      includeDeleted: z.boolean().optional().describe("If true, include voided (Status=DELETED) entries in the results. Default false. Useful for BAS review where seeing voided entries matters."),
      compactFields: z.boolean().optional().describe("If true, each transaction is projected to a compact 13-field shape (BankTransactionID, Date, Total, Status, Type, BankAccountName, ContactName, FirstLineDescription, etc.) — ~70-80% smaller than the full Xero record. Strongly recommended for high-volume calls (>30 records) to avoid MCP response truncation."),
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

  // ── Income in advance (monthly packages) ─────────────────────────────────
  {
    name: "xero_income_in_advance_audit",
    description:
      "Audit the Income in Advance accounts used for monthly packages (804.YY Tax, 805.YY Strategy, 806.YY BAS & BK, 804.5 Other; YY = financial year) and the nil-total contra invoices that move fees to income when a job goes to OFS. Returns issues — contra_has_gst, empty_contra, contra_wrong_income_account (errors); over_reallocated, possible_wrong_year, wrong_service_type, old_year_balance (warnings); contra_contact_has_no_monthly_invoice, monthly_line_straight_to_income (notes) — and the ex-GST balance left per contact and account. To check whether jobs at OFS have had their contra, compare these balances with the jobs realised at OFS. Reads many invoices; can take a minute.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      fromDate: z.string().optional().describe("Read invoices dated on/after this (YYYY-MM-DD). Default 2022-07-01."),
      contact: z.string().optional().describe("Only show this contact (name contains). Also returns its balances."),
      account: z.string().optional().describe("Only show this Income in Advance account, e.g. 804.26"),
      includeBalances: z.boolean().optional().describe("Return every non-zero contact/account balance (default false unless contact is given)"),
      maxIssues: z.number().int().min(1).max(1000).optional().describe("Default 150"),
    }),
    handler: async (input) => iia.incomeInAdvanceAudit(input as Parameters<typeof iia.incomeInAdvanceAudit>[0]),
  },

  {
    name: "xero_prepaid_income_position",
    description:
      "The prepaid income (Income in Advance) position at a date, ex GST: prepaidIncomeLiability = fees billed for work not yet realised (clients in credit); realisedAheadOfBilling = work realised before its instalments were billed (clients in debit, a timing difference). Split by account, reconciled to Xero's balance sheet at the same date (notFromInvoices = manual journals/opening balances). Set includeClients or contact for the per-client breakdown. Reads all sales invoices; can take a minute.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      asAt: z.string().optional().describe("Position at this date, YYYY-MM-DD (default today)"),
      contact: z.string().optional().describe("Only list this contact's balances (name contains)"),
      includeClients: z.boolean().optional().describe("List each client's balance, largest first"),
      maxClients: z.number().int().min(1).max(1000).optional().describe("Default 100"),
      fromDate: z.string().optional().describe("Ignore invoices before this date (default: all)"),
    }),
    handler: async (input) => iia.prepaidIncomePosition(input as Parameters<typeof iia.prepaidIncomePosition>[0]),
  },

  {
    name: "xero_income_in_advance_detail",
    description:
      "What one Income in Advance account is made of, at a date (ex GST): each client's invoiced, credit notes, moved to income (contras), balance and position (prepaid / realised ahead of billing / debit to review), with a comment; the account totals reconciled to the balance sheet; and the lines behind them, each checked — monthly lines for service type (Tax 804 / Strategy 805 / BAS & BK 806) and financial year, contras for GST and income account. Without contact, only flagged lines are listed; give contact (or allLines: true) for every line. Use this to answer 'what is in 804.25?' or 'why does McInnes have a balance in 806.25?'.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      account: z.string().describe("The Income in Advance account, e.g. 804.25, 805.26, 806.26 or 804.5"),
      asAt: z.string().optional().describe("YYYY-MM-DD (default today)"),
      contact: z.string().optional().describe("Only this client (name contains): returns all its lines in the account"),
      allLines: z.boolean().optional().describe("List every line, not just flagged ones (can be long)"),
      maxLines: z.number().int().min(1).max(5000).optional().describe("Default 200 (500 with contact)"),
    }),
    handler: async (input) => iia.incomeInAdvanceDetail(input as Parameters<typeof iia.incomeInAdvanceDetail>[0]),
  },
];

// Tools that change data in Xero. Everything here creates DRAFTS only.
export const writeTools: ToolDefinition[] = [
  {
    name: "xero_create_manual_journal",
    description:
      "Create a DRAFT manual journal in Xero. It is never posted: a person reviews and posts it in Xero. Each line has an accountCode and EITHER a debit OR a credit (positive numbers). With lineAmountTypes NoTax (the default) total debits must equal total credits. Use xero_list_accounts for account codes and xero_list_tracking_categories for tracking. Always confirm the organisation, date, narration and lines with the user before calling.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      date: z.string().describe("Journal date, YYYY-MM-DD"),
      narration: z.string().describe("Narration shown on the journal, e.g. 'FY26 depreciation adjustment'"),
      lines: z
        .array(
          z.object({
            accountCode: z.string().describe("Account code from the chart of accounts"),
            debit: z.number().positive().optional().describe("Debit amount (leave out for a credit line)"),
            credit: z.number().positive().optional().describe("Credit amount (leave out for a debit line)"),
            description: z.string().optional(),
            taxType: z.string().optional().describe("Tax type, e.g. INPUT or OUTPUT. Only with lineAmountTypes Exclusive/Inclusive."),
            tracking: z
              .array(z.object({ name: z.string(), option: z.string() }))
              .max(2)
              .optional()
              .describe("Tracking category name and option, up to two"),
          })
        )
        .min(2),
      lineAmountTypes: z.enum(["NoTax", "Exclusive", "Inclusive"]).optional().describe("Default NoTax"),
      showOnCashBasisReports: z.boolean().optional().describe("Default true"),
    }),
    handler: async (input) => xero.createDraftManualJournal(input as xero.ManualJournalInput),
  },

  {
    name: "xero_create_contra_invoice",
    description:
      "Create a contra invoice for a monthly-package client when a job goes to OFS: a nil-total sales invoice that moves the ex-GST fee from an Income in Advance account to income, with BAS Excluded on every line (no GST — it was already reported on the monthly invoices). Approved by default, so Xero marks it Paid straight away; it is not emailed. The income account is set from the Income in Advance account (804.YY→200, 805.YY→204, 806.YY→202); for 804.5 Other you must give incomeAccount. Move the job's full fee ex GST. If that is more than has been billed so far because the work was done before the instalments finished, it is refused unless aheadOfBilling: true. Make it out to the same contact as the monthly invoices. Use preview: true first to show the user what will be created, then call again without preview once they agree.",
    inputSchema: z.object({
      tenantId: tenantIdField,
      contactId: z.string().optional().describe("Xero ContactID (or give contactName)"),
      contactName: z.string().optional().describe("Exact contact name, as on the monthly invoices"),
      date: z.string().optional().describe("Invoice date YYYY-MM-DD (default today, Sydney time)"),
      reference: z.string().describe('Reference, e.g. "2026 Tax Contra" or "June 2026 BAS Contra"'),
      lines: z
        .array(
          z.object({
            incomeInAdvanceAccount: z.string().describe("e.g. 804.26, 805.26, 806.26 or 804.5"),
            amount: z.number().positive().describe("Fee to move, EX GST"),
            incomeAccount: z.string().optional().describe("Only for 804.5 Other: the income account to move it to"),
            description: z.string().optional().describe('Default "Reallocate <year> <Tax/Strategy/BAS & BK> fee"'),
          })
        )
        .min(1),
      approve: z.boolean().optional().describe("Default true (approved, auto-paid). false leaves it as a draft."),
      preview: z.boolean().optional().describe("true: check everything and return what would be created, without creating it"),
      aheadOfBilling: z
        .boolean()
        .optional()
        .describe("The job was done before all its instalments were invoiced: allow moving the full fee even though less has been billed so far"),
    }),
    handler: async (input) => iia.createContraInvoice(input as iia.ContraInput),
  },
];
