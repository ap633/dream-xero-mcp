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
];
