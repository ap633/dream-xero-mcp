import { z } from "zod";
import * as xero from "./xero-client.js";

// ─── Tool Definitions ────────────────────────────────────────────────────────
// Each tool has: name, description, inputSchema (Zod), and handler.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown) => Promise<unknown>;
}

export const tools: ToolDefinition[] = [
  // ── Organisations ───────────────────────────────────────────────────────
  {
    name: "xero_list_organisations",
    description:
      "List all Xero organisations (tenants) connected to this custom connection. Returns tenantId, tenantName, and tenantType for each.",
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
      "Switch the active Xero organisation. All subsequent tool calls will use the selected tenantId. Use xero_list_organisations first to get available tenantIds.",
    inputSchema: z.object({
      tenantId: z
        .string()
        .describe("The Xero tenantId of the organisation to switch to"),
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
    description:
      "List sales invoices (accounts receivable) from Xero. Supports filtering by status, contact, and date range. Paginated — use page parameter for large datasets.",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"])
        .optional()
        .describe("Filter by invoice status"),
      contactId: z
        .string()
        .optional()
        .describe("Filter by Xero Contact GUID"),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number (100 records per page)"),
    }),
    handler: async (input) => {
      const params = input as {
        status?: string;
        contactId?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
      };
      return xero.listInvoices(params);
    },
  },

  {
    name: "xero_get_invoice",
    description:
      "Get a single Xero invoice by its InvoiceID (GUID) or InvoiceNumber. Returns full invoice details including line items, payments applied, and contact information.",
    inputSchema: z.object({
      invoiceIdOrNumber: z
        .string()
        .describe("Xero Invoice ID (GUID) or Invoice Number (e.g. INV-0001)"),
    }),
    handler: async (input) => {
      const { invoiceIdOrNumber } = input as { invoiceIdOrNumber: string };
      return xero.getInvoice(invoiceIdOrNumber);
    },
  },

  // ── Bills ─────────────────────────────────────────────────────────────────
  {
    name: "xero_list_bills",
    description:
      "List bills (accounts payable / supplier invoices) from Xero. Supports filtering by status, supplier contact, and date range.",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"])
        .optional()
        .describe("Filter by bill status"),
      contactId: z
        .string()
        .optional()
        .describe("Filter by supplier Contact GUID"),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      const params = input as {
        status?: string;
        contactId?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
      };
      return xero.listBills(params);
    },
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  {
    name: "xero_list_payments",
    description:
      "List payments recorded in Xero. Returns payments applied to invoices or bills, including amount, date, bank account, and reference.",
    inputSchema: z.object({
      status: z
        .enum(["AUTHORISED", "DELETED"])
        .optional()
        .describe("Filter by payment status"),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      const params = input as {
        status?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
      };
      return xero.listPayments(params);
    },
  },

  // ── Bank Transactions ─────────────────────────────────────────────────────
  {
    name: "xero_list_bank_transactions",
    description:
      "List bank transactions from Xero. Shows spend/receive money transactions and their reconciliation status. Filter by bank account, status, or date range.",
    inputSchema: z.object({
      bankAccountId: z
        .string()
        .optional()
        .describe(
          "Filter by bank account AccountID (GUID). Use xero_list_bank_accounts to get IDs."
        ),
      status: z
        .enum(["AUTHORISED", "DELETED"])
        .optional()
        .describe("Filter by transaction status"),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      const params = input as {
        bankAccountId?: string;
        status?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
      };
      return xero.listBankTransactions(params);
    },
  },

  {
    name: "xero_list_bank_accounts",
    description:
      "List all bank accounts set up in Xero. Returns account name, code, currency, and AccountID needed for filtering bank transactions.",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.listBankAccounts();
    },
  },

  // ── Chart of Accounts ─────────────────────────────────────────────────────
  {
    name: "xero_list_accounts",
    description:
      "List the chart of accounts from Xero. Returns all GL accounts with their code, name, type, and tax type. Filter by account type (e.g. BANK, REVENUE, EXPENSE, ASSET, LIABILITY).",
    inputSchema: z.object({
      type: z
        .enum([
          "BANK",
          "CURRENT",
          "CURRLIAB",
          "DEPRECIATN",
          "DIRECTCOSTS",
          "EQUITY",
          "EXPENSE",
          "FIXED",
          "INVENTORY",
          "LIABILITY",
          "NONCURRENT",
          "OTHERINCOME",
          "OVERHEADS",
          "PREPAYMENT",
          "REVENUE",
          "SALES",
          "TERMLIAB",
          "PAYGLIABILITY",
          "SUPERANNUATIONEXPENSE",
          "SUPERANNUATIONLIABILITY",
          "WAGESEXPENSE",
        ])
        .optional()
        .describe("Filter by account type"),
      status: z
        .enum(["ACTIVE", "ARCHIVED"])
        .optional()
        .describe("Filter by account status (default: ACTIVE)"),
    }),
    handler: async (input) => {
      const params = input as { type?: string; status?: string };
      return xero.listAccounts(params);
    },
  },

  // ── Journal Entries ───────────────────────────────────────────────────────
  {
    name: "xero_list_journal_entries",
    description:
      "List journal entries from Xero's general ledger. Returns manual journals and system-generated journal lines. Use offset for pagination (100 per page).",
    inputSchema: z.object({
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Offset for pagination (0 = first 100 records)"),
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      const params = input as {
        offset?: number;
        dateFrom?: string;
        dateTo?: string;
      };
      return xero.listJournals(params);
    },
  },

  // ── Reports ───────────────────────────────────────────────────────────────
  {
    name: "xero_get_profit_and_loss",
    description:
      "Retrieve the Profit & Loss (Income Statement) report from Xero. Shows income, cost of sales, gross profit, expenses, and net profit for the specified period.",
    inputSchema: z.object({
      fromDate: z
        .string()
        .optional()
        .describe("Report start date (YYYY-MM-DD). Defaults to start of current financial year."),
      toDate: z
        .string()
        .optional()
        .describe("Report end date (YYYY-MM-DD). Defaults to today."),
      periods: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Number of comparison periods to include"),
      timeframe: z
        .enum(["MONTH", "QUARTER", "YEAR"])
        .optional()
        .describe("Timeframe for comparison periods"),
    }),
    handler: async (input) => {
      const params = input as {
        fromDate?: string;
        toDate?: string;
        periods?: number;
        timeframe?: string;
      };
      return xero.getProfitAndLoss(params);
    },
  },

  {
    name: "xero_get_balance_sheet",
    description:
      "Retrieve the Balance Sheet report from Xero. Shows assets, liabilities, and equity as at a specified date.",
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe("As-at date for the balance sheet (YYYY-MM-DD). Defaults to today."),
      periods: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Number of comparison periods"),
      timeframe: z
        .enum(["MONTH", "QUARTER", "YEAR"])
        .optional()
        .describe("Timeframe for comparison periods"),
    }),
    handler: async (input) => {
      const params = input as {
        date?: string;
        periods?: number;
        timeframe?: string;
      };
      return xero.getBalanceSheet(params);
    },
  },

  {
    name: "xero_get_cash_flow",
    description:
      "Retrieve the Cash Flow Summary report from Xero. Shows cash movements from operating, investing, and financing activities for the period.",
    inputSchema: z.object({
      fromDate: z
        .string()
        .optional()
        .describe("Report start date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("Report end date (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      const params = input as { fromDate?: string; toDate?: string };
      return xero.getCashFlow(params);
    },
  },

  // ── Contacts ──────────────────────────────────────────────────────────────
  {
    name: "xero_list_contacts",
    description:
      "List contacts (customers and/or suppliers) from Xero. Filter by customer/supplier flag or search by name. Returns contact details including email, phone, and outstanding balances.",
    inputSchema: z.object({
      name: z
        .string()
        .optional()
        .describe("Search contacts by name (partial match)"),
      isCustomer: z
        .boolean()
        .optional()
        .describe("Filter to customers only (contacts with sales invoices)"),
      isSupplier: z
        .boolean()
        .optional()
        .describe("Filter to suppliers only (contacts with bills)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      const params = input as {
        name?: string;
        isCustomer?: boolean;
        isSupplier?: boolean;
        page?: number;
      };
      return xero.listContacts(params);
    },
  },

  {
    name: "xero_get_contact",
    description:
      "Get a single Xero contact by their ContactID (GUID) or name. Returns full contact details including addresses, phone numbers, email, tax numbers, and account balances.",
    inputSchema: z.object({
      contactIdOrName: z
        .string()
        .describe("Xero Contact ID (GUID) or exact contact name"),
    }),
    handler: async (input) => {
      const { contactIdOrName } = input as { contactIdOrName: string };
      return xero.getContact(contactIdOrName);
    },
  },

  // ── Credit Notes ──────────────────────────────────────────────────────────
  {
    name: "xero_list_credit_notes",
    description:
      "List credit notes from Xero (both accounts receivable and accounts payable credit notes). Filter by status, contact, or date range.",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"])
        .optional()
        .describe("Filter by credit note status"),
      contactId: z.string().optional().describe("Filter by Contact GUID"),
      dateFrom: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("End date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listCreditNotes(input as Parameters<typeof xero.listCreditNotes>[0]);
    },
  },

  {
    name: "xero_get_credit_note",
    description:
      "Get a single credit note by its CreditNoteID (GUID) or CreditNoteNumber. Returns full details including line items and allocations.",
    inputSchema: z.object({
      creditNoteIdOrNumber: z.string().describe("Credit Note ID (GUID) or Credit Note Number"),
    }),
    handler: async (input) => {
      const { creditNoteIdOrNumber } = input as { creditNoteIdOrNumber: string };
      return xero.getCreditNote(creditNoteIdOrNumber);
    },
  },

  // ── Quotes ────────────────────────────────────────────────────────────────
  {
    name: "xero_list_quotes",
    description:
      "List quotes/proposals from Xero. Shows sales quotes sent to customers with status (DRAFT, SENT, DECLINED, ACCEPTED, INVOICED, DELETED).",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "SENT", "DECLINED", "ACCEPTED", "INVOICED", "DELETED"])
        .optional()
        .describe("Filter by quote status"),
      contactId: z.string().optional().describe("Filter by Contact GUID"),
      dateFrom: z.string().optional().describe("Quote date from (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("Quote date to (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listQuotes(input as Parameters<typeof xero.listQuotes>[0]);
    },
  },

  {
    name: "xero_get_quote",
    description:
      "Get a single quote by its QuoteID (GUID) or QuoteNumber. Returns full quote details including line items, expiry date, and terms.",
    inputSchema: z.object({
      quoteIdOrNumber: z.string().describe("Quote ID (GUID) or Quote Number"),
    }),
    handler: async (input) => {
      const { quoteIdOrNumber } = input as { quoteIdOrNumber: string };
      return xero.getQuote(quoteIdOrNumber);
    },
  },

  // ── Purchase Orders ───────────────────────────────────────────────────────
  {
    name: "xero_list_purchase_orders",
    description:
      "List purchase orders from Xero. Filter by status (DRAFT, AUTHORISED, BILLED, DELETED) or date range.",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "AUTHORISED", "BILLED", "DELETED"])
        .optional()
        .describe("Filter by purchase order status"),
      dateFrom: z.string().optional().describe("From date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("To date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listPurchaseOrders(input as Parameters<typeof xero.listPurchaseOrders>[0]);
    },
  },

  {
    name: "xero_get_purchase_order",
    description:
      "Get a single purchase order by its PurchaseOrderID (GUID) or PurchaseOrderNumber. Returns full details including line items and delivery address.",
    inputSchema: z.object({
      purchaseOrderIdOrNumber: z.string().describe("Purchase Order ID (GUID) or PO Number"),
    }),
    handler: async (input) => {
      const { purchaseOrderIdOrNumber } = input as { purchaseOrderIdOrNumber: string };
      return xero.getPurchaseOrder(purchaseOrderIdOrNumber);
    },
  },

  // ── Items ─────────────────────────────────────────────────────────────────
  {
    name: "xero_list_items",
    description:
      "List products and services (items) set up in Xero. Returns item code, name, description, unit price, account codes, and tax type. Used on invoices and bills.",
    inputSchema: z.object({
      searchTerm: z.string().optional().describe("Search items by code or name"),
    }),
    handler: async (input) => {
      return xero.listItems(input as Parameters<typeof xero.listItems>[0]);
    },
  },

  {
    name: "xero_get_item",
    description:
      "Get a single item (product/service) by its ItemID (GUID) or ItemCode. Returns pricing, account codes, and purchase/sales details.",
    inputSchema: z.object({
      itemIdOrCode: z.string().describe("Item ID (GUID) or Item Code"),
    }),
    handler: async (input) => {
      const { itemIdOrCode } = input as { itemIdOrCode: string };
      return xero.getItem(itemIdOrCode);
    },
  },

  // ── Tracking Categories ───────────────────────────────────────────────────
  {
    name: "xero_list_tracking_categories",
    description:
      "List tracking categories and their options from Xero. Tracking categories allow transactions to be tagged for departmental or project reporting (e.g. 'Region', 'Department').",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.listTrackingCategories();
    },
  },

  // ── Tax Rates ─────────────────────────────────────────────────────────────
  {
    name: "xero_list_tax_rates",
    description:
      "List tax rates configured in Xero. Returns tax type code, name, effective rate, and status. Essential for understanding GST/tax codes used on invoices and bills.",
    inputSchema: z.object({
      taxType: z
        .string()
        .optional()
        .describe("Filter by tax type (e.g. OUTPUT, INPUT, GSTONIMPORTS, EXEMPTOUTPUT)"),
    }),
    handler: async (input) => {
      return xero.listTaxRates(input as Parameters<typeof xero.listTaxRates>[0]);
    },
  },

  // ── Manual Journals ───────────────────────────────────────────────────────
  {
    name: "xero_list_manual_journals",
    description:
      "List manual journal entries from Xero. Returns manually created journal adjustments including narration, date, and debit/credit lines.",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "POSTED", "DELETED", "VOIDED"])
        .optional()
        .describe("Filter by journal status"),
      dateFrom: z.string().optional().describe("From date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("To date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listManualJournals(input as Parameters<typeof xero.listManualJournals>[0]);
    },
  },

  // ── Repeating Invoices ────────────────────────────────────────────────────
  {
    name: "xero_list_repeating_invoices",
    description:
      "List repeating invoice templates from Xero. Shows recurring billing schedules including frequency, next scheduled date, and amounts.",
    inputSchema: z.object({
      status: z
        .enum(["AUTHORISED", "DELETED"])
        .optional()
        .describe("Filter by repeating invoice status"),
    }),
    handler: async (input) => {
      return xero.listRepeatingInvoices(input as Parameters<typeof xero.listRepeatingInvoices>[0]);
    },
  },

  // ── Overpayments & Prepayments ────────────────────────────────────────────
  {
    name: "xero_list_overpayments",
    description:
      "List overpayments recorded in Xero (payments received or made in excess of the invoice amount). Shows remaining credit available to allocate.",
    inputSchema: z.object({
      contactId: z.string().optional().describe("Filter by Contact GUID"),
      dateFrom: z.string().optional().describe("From date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("To date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listOverpayments(input as Parameters<typeof xero.listOverpayments>[0]);
    },
  },

  {
    name: "xero_list_prepayments",
    description:
      "List prepayments from Xero (payments made or received before an invoice is issued). Shows balance remaining and any allocations to invoices.",
    inputSchema: z.object({
      contactId: z.string().optional().describe("Filter by Contact GUID"),
      dateFrom: z.string().optional().describe("From date (YYYY-MM-DD)"),
      dateTo: z.string().optional().describe("To date (YYYY-MM-DD)"),
      page: z.number().int().min(1).default(1).describe("Page number"),
    }),
    handler: async (input) => {
      return xero.listPrepayments(input as Parameters<typeof xero.listPrepayments>[0]);
    },
  },

  // ── Extended Reports ──────────────────────────────────────────────────────
  {
    name: "xero_get_aged_receivables",
    description:
      "Retrieve the Aged Receivables report from Xero. Shows outstanding amounts owed by customers, broken into aging buckets (Current, 30, 60, 90+ days overdue). Critical for debtor management.",
    inputSchema: z.object({
      contactId: z
        .string()
        .optional()
        .describe("Filter to a specific customer Contact GUID"),
      date: z
        .string()
        .optional()
        .describe("As-at date for aging calculation (YYYY-MM-DD). Defaults to today."),
      fromDate: z.string().optional().describe("Show invoices from this date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("Show invoices to this date (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      return xero.getAgedReceivables(input as Parameters<typeof xero.getAgedReceivables>[0]);
    },
  },

  {
    name: "xero_get_aged_payables",
    description:
      "Retrieve the Aged Payables report from Xero. Shows outstanding amounts owed to suppliers, broken into aging buckets (Current, 30, 60, 90+ days overdue). Critical for creditor management.",
    inputSchema: z.object({
      contactId: z
        .string()
        .optional()
        .describe("Filter to a specific supplier Contact GUID"),
      date: z
        .string()
        .optional()
        .describe("As-at date for aging calculation (YYYY-MM-DD). Defaults to today."),
      fromDate: z.string().optional().describe("Show bills from this date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("Show bills to this date (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      return xero.getAgedPayables(input as Parameters<typeof xero.getAgedPayables>[0]);
    },
  },

  {
    name: "xero_get_trial_balance",
    description:
      "Retrieve the Trial Balance report from Xero. Shows all GL account balances (debit and credit) as at a specified date. Standard check that debits equal credits.",
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe("As-at date for the trial balance (YYYY-MM-DD). Defaults to today."),
      paymentsOnly: z
        .boolean()
        .optional()
        .describe("If true, shows cash-basis balances (payments only, no accruals)"),
    }),
    handler: async (input) => {
      return xero.getTrialBalance(input as Parameters<typeof xero.getTrialBalance>[0]);
    },
  },

  {
    name: "xero_get_executive_summary",
    description:
      "Retrieve the Executive Summary report from Xero. Provides a high-level KPI dashboard including revenue, gross profit, net profit, cash position, and key ratios for the selected month.",
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe("Month to report on — any date within that month (YYYY-MM-DD). Defaults to current month."),
    }),
    handler: async (input) => {
      return xero.getExecutiveSummary(input as Parameters<typeof xero.getExecutiveSummary>[0]);
    },
  },

  {
    name: "xero_get_bank_summary",
    description:
      "Retrieve the Bank Summary report from Xero. Shows opening and closing balances for all bank accounts, plus total receipts and payments for the period.",
    inputSchema: z.object({
      fromDate: z.string().optional().describe("Period start date (YYYY-MM-DD)"),
      toDate: z.string().optional().describe("Period end date (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      return xero.getBankSummary(input as Parameters<typeof xero.getBankSummary>[0]);
    },
  },

  {
    name: "xero_get_budget_summary",
    description:
      "Retrieve the Budget Summary report from Xero. Compares actual income and expenses against budgeted amounts for the period.",
    inputSchema: z.object({
      date: z.string().optional().describe("Period start date (YYYY-MM-DD)"),
      periods: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Number of periods to include (1–12)"),
      timeframe: z
        .number()
        .int()
        .optional()
        .describe("Timeframe in months per period (1 = monthly, 3 = quarterly, 12 = annual)"),
    }),
    handler: async (input) => {
      return xero.getBudgetSummary(input as Parameters<typeof xero.getBudgetSummary>[0]);
    },
  },

  {
    name: "xero_get_gst_report",
    description:
      "Retrieve the GST / BAS (Business Activity Statement) report from Xero. Shows GST collected on sales, GST paid on purchases, and the net GST payable or refundable for the period. Essential for Australian BAS lodgement.",
    inputSchema: z.object({
      fromDate: z
        .string()
        .optional()
        .describe("BAS period start date (YYYY-MM-DD)"),
      toDate: z
        .string()
        .optional()
        .describe("BAS period end date (YYYY-MM-DD)"),
    }),
    handler: async (input) => {
      return xero.getGSTReport(input as Parameters<typeof xero.getGSTReport>[0]);
    },
  },

  // ── Fixed Assets ──────────────────────────────────────────────────────────
  {
    name: "xero_list_assets",
    description:
      "List fixed assets from Xero's asset register. Returns asset name, asset number, purchase date, purchase price, depreciation method, and book value. Filter by status (DRAFT, REGISTERED, DISPOSED).",
    inputSchema: z.object({
      status: z
        .enum(["DRAFT", "REGISTERED", "DISPOSED"])
        .optional()
        .describe("Filter by asset status"),
      page: z.number().int().min(1).default(1).describe("Page number"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(100)
        .describe("Records per page (max 100)"),
    }),
    handler: async (input) => {
      return xero.listAssets(input as Parameters<typeof xero.listAssets>[0]);
    },
  },

  {
    name: "xero_get_asset_settings",
    description:
      "Get the fixed asset settings for the Xero organisation. Returns default depreciation accounts, asset account, and depreciation method defaults.",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.getAssetSettings();
    },
  },

  // ── Contact Groups ────────────────────────────────────────────────────────
  {
    name: "xero_list_contact_groups",
    description:
      "List contact groups from Xero. Contact groups are used to categorise contacts (e.g. 'VIP Clients', 'Contractors'). Returns group name and member contacts.",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.listContactGroups();
    },
  },

  // ── Currencies ────────────────────────────────────────────────────────────
  {
    name: "xero_list_currencies",
    description:
      "List currencies enabled in the Xero organisation. Returns currency code and description. Useful for multi-currency clients.",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.listCurrencies();
    },
  },

  // ── Organisation ──────────────────────────────────────────────────────────
  {
    name: "xero_get_organisation",
    description:
      "Get organisation details for the active Xero tenant. Returns the organisation name, ABN/tax number, financial year end, accounting basis (cash/accrual), base currency, and timezone.",
    inputSchema: z.object({}),
    handler: async () => {
      return xero.getOrganisationDetails();
    },
  },
];
