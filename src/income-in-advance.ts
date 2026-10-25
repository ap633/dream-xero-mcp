// -----------------------------------------------------------------------------
// Income in advance (monthly packages) and contra invoices.
//
// Monthly package invoices put the fee, with GST, into Income in Advance
// liability accounts: 804.YY Tax, 805.YY Strategy, 806.YY BAS & BK (YY = the
// financial year the work belongs to), or 804.5 Other (lump sums). When a job
// goes to OFS, a nil-total "contra" invoice to the same contact moves the
// ex-GST fee from Income in Advance to income, with no GST (BAS Excluded),
// because the GST was already reported on the monthly invoices.
//
// This module keeps a per-contact ledger of those accounts from the sales
// invoices and credit notes, audits it, and creates contra invoices.
// Manual journals into these accounts are not included.
// -----------------------------------------------------------------------------

import axios, { AxiosInstance } from "axios";
import { getApiClient, resolveTenantId, getTenants, addDateRange, xeroErrorMessage } from "./xero-client.js";

// ─── Accounts ────────────────────────────────────────────────────────────────

const FAMILIES: Record<string, { income: string; label: string }> = {
  "804": { income: "200", label: "Tax" },
  "805": { income: "204", label: "Strategy" },
  "806": { income: "202", label: "BAS & BK" },
};

export interface XeroAccount { AccountID?: string; Code?: string; Name: string; Status: string; Class?: string; Type?: string }

export interface IiaAccount {
  code: string;
  name: string;
  /** The financial year (e.g. 2026), or null for "Other" accounts such as 804.5. */
  year: number | null;
  /** The income account a contra must move it to, or null if any income account is allowed. */
  income: string | null;
  label: string;
}

/** Is this an Income in Advance account, and what are its rules? */
export function iiaAccount(code: string | undefined, accounts: XeroAccount[]): IiaAccount | null {
  const m = /^(80[456])\.(\d+)$/.exec(code ?? "");
  if (!m) return null;
  const acc = accounts.find((a) => a.Code === code);
  if (!acc || !/income in advance/i.test(acc.Name)) return null;
  const yearly = m[2].length === 2;
  return {
    code: code!,
    name: acc.Name,
    year: yearly ? 2000 + Number(m[2]) : null,
    income: yearly ? FAMILIES[m[1]].income : null,
    label: yearly ? FAMILIES[m[1]].label : "Other",
  };
}

// ─── Documents ───────────────────────────────────────────────────────────────

export interface XeroLine {
  AccountCode?: string;
  LineAmount?: number;
  TaxAmount?: number;
  TaxType?: string;
  Description?: string;
}

export interface XeroDoc {
  kind: "invoice" | "creditnote";
  id: string;
  number?: string;
  date: string;
  status: string;
  reference?: string;
  contactId: string;
  contactName: string;
  total: number;
  lineAmountTypes?: string;
  lines: XeroLine[];
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;

function exGstCents(line: XeroLine, lineAmountTypes?: string): number {
  const amount = line.LineAmount ?? 0;
  const tax = lineAmountTypes === "Inclusive" ? line.TaxAmount ?? 0 : 0;
  return cents(amount - tax);
}

function isoDate(raw: unknown): string {
  const m = /\/Date\((-?\d+)/.exec(String(raw ?? ""));
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return String(raw ?? "").slice(0, 10);
}

/** A nil-total sales invoice. With Income in Advance lines it's a contra. */
const isNil = (d: XeroDoc) => d.kind === "invoice" && cents(d.total) === 0;

// ─── Ledger ──────────────────────────────────────────────────────────────────

export interface Balance {
  contactId: string;
  contact: string;
  account: string;
  accountName: string;
  /** Ex GST, from monthly/charge invoices. */
  invoiced: number;
  /** Ex GST, from credit notes. */
  credited: number;
  /** Ex GST, moved to income by contra invoices. */
  reallocated: number;
  /**
   * invoiced − credited − reallocated. Positive: prepaid (a liability).
   * Negative: work realised ahead of billing, still to be invoiced.
   */
  balance: number;
  /** The latest monthly/charge invoice on this account for this contact. */
  lastInvoiceDate: string | null;
}

/** Each contact's position in each Income in Advance account, from documents dated on or before asAt. */
export function buildLedger(docs: XeroDoc[], accounts: XeroAccount[], asAt?: string): Balance[] {
  const rows = new Map<string, { contactId: string; contact: string; account: string; accountName: string; inv: number; cn: number; re: number; last: string | null }>();
  for (const d of docs) {
    if (asAt && d.date > asAt) continue;
    for (const l of d.lines) {
      const acc = iiaAccount(l.AccountCode, accounts);
      if (!acc) continue;
      const key = `${d.contactId}|${acc.code}`;
      const row = rows.get(key) ?? { contactId: d.contactId, contact: d.contactName, account: acc.code, accountName: acc.name, inv: 0, cn: 0, re: 0, last: null };
      const c = exGstCents(l, d.lineAmountTypes);
      if (d.kind === "creditnote") row.cn += c;
      else if (isNil(d)) row.re -= c; // contra lines take the account down: negative amounts
      else {
        row.inv += c;
        if (!row.last || d.date > row.last) row.last = d.date;
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((r) => ({
      contactId: r.contactId,
      contact: r.contact,
      account: r.account,
      accountName: r.accountName,
      invoiced: dollars(r.inv),
      credited: dollars(r.cn),
      reallocated: dollars(r.re),
      balance: dollars(r.inv - r.cn - r.re),
      lastInvoiceDate: r.last,
    }))
    .sort((a, b) => a.contact.localeCompare(b.contact) || a.account.localeCompare(b.account));
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type IssueType =
  | "contra_has_gst"
  | "empty_contra"
  | "contra_wrong_income_account"
  | "contra_contact_has_no_monthly_invoice"
  | "over_reallocated"
  | "realised_ahead_of_billing"
  | "possible_wrong_year"
  | "wrong_service_type"
  | "old_year_balance"
  | "monthly_line_straight_to_income";

const SEVERITY: Record<IssueType, "error" | "warning" | "note"> = {
  contra_has_gst: "error",
  empty_contra: "error",
  contra_wrong_income_account: "error",
  over_reallocated: "warning",
  possible_wrong_year: "warning",
  wrong_service_type: "warning",
  old_year_balance: "warning",
  contra_contact_has_no_monthly_invoice: "note",
  monthly_line_straight_to_income: "note",
  realised_ahead_of_billing: "note",
};

/** A contact counts as still being billed if it was invoiced on this account in the last ~2 months. */
const STILL_BILLING_DAYS = 62;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export interface Issue {
  type: IssueType;
  severity: "error" | "warning" | "note";
  contact: string;
  invoice?: string;
  date?: string;
  account?: string;
  amount?: number;
  detail: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * The financial year (ending 30 June) a monthly-invoice line belongs to, read
 * from Ignition's service text, or null if it can't tell:
 *   "2026 Individual Tax Return ..."           → 2026
 *   "2025 BAS Quarterly Lodgement - December"  → Dec 2025 → 2026
 *   "2026 IAS Monthly Lodgement - March"       → Mar 2026 → 2026
 */
export function financialYearOf(description: string | undefined): number | null {
  const text = (description ?? "").trim();
  const y = /^(20\d\d)\b/.exec(text);
  if (!y) return null;
  const year = Number(y[1]);
  const head = text.split(/\r?\n/)[0];
  const month = /-\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.exec(head);
  if (month) {
    const m = MONTHS.indexOf(month[1].toLowerCase()) + 1;
    return m >= 7 ? year + 1 : year;
  }
  return /tax return|financial statements/i.test(head) ? year : null;
}

/**
 * Which account family a service belongs in, from its description, or null
 * if it isn't clearly one (GST registration, PLSL, TPAR, ASIC, Xero, ...):
 * strategy/advisory → 805, BAS/IAS/bookkeeping/payroll → 806,
 * tax returns/financial statements/rental/CGT/amendments → 804.
 */
export function serviceFamily(description: string | undefined): "804" | "805" | "806" | null {
  const head = (description ?? "").split(/\r?\n/)[0];
  if (/strateg|business advisory|advisory session|planning session/i.test(head)) return "805";
  if (/\b(BAS|IAS)\b|bookkeep|payroll|activity statement|PPBK/i.test(head)) return "806";
  if (/tax return|financial statements|rental schedule|\bCGT\b|crypto|GST reconciliation|amendment|return not required|entities included/i.test(head)) return "804";
  return null;
}

export interface LineProblem { type: "possible_wrong_year" | "wrong_service_type"; detail: string }

const yy = (year: number) => String(year % 100).padStart(2, "0");

/**
 * Check one monthly-invoice line coded to a yearly Income in Advance account:
 * is the service the right type for the account, and the right financial year?
 * A year is only flagged when an account for that year exists (catch-up years
 * with no account of their own can only go in the package year).
 */
export function checkMonthlyLine(description: string | undefined, acc: IiaAccount, accounts: XeroAccount[]) {
  const fy = financialYearOf(description);
  const family = serviceFamily(description);
  const problems: LineProblem[] = [];
  if (acc.year !== null) {
    const own = acc.code.split(".")[0];
    const head = (description ?? "").split(/\r?\n/)[0].slice(0, 70);
    if (family && family !== own) {
      problems.push({
        type: "wrong_service_type",
        detail: `"${head}" is ${FAMILIES[family].label} work in a ${FAMILIES[own].label} account (${acc.code}); it belongs in ${family}.${yy(acc.year)}.`,
      });
    }
    const target = fy !== null ? iiaAccount(`${family ?? own}.${yy(fy)}`, accounts) : null;
    if (fy !== null && fy !== acc.year && target) {
      problems.push({ type: "possible_wrong_year", detail: `"${head}" looks like FY${fy} but is coded to ${acc.code} (FY${acc.year}); it belongs in ${target.code}.` });
    }
  }
  return { financialYear: fy, serviceType: family ? FAMILIES[family].label : null, problems };
}

/** The financial year containing a date (FY2027 = 1 Jul 2026 – 30 Jun 2027). */
export function financialYearOfDate(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return m >= 7 ? y + 1 : y;
}

export function auditLedger(docs: XeroDoc[], accounts: XeroAccount[], today: string): { issues: Issue[]; balances: Balance[] } {
  // Checks are relative to `today`, which also makes them testable.
  const issues: Issue[] = [];
  const add = (type: IssueType, i: Omit<Issue, "type" | "severity">) => issues.push({ type, severity: SEVERITY[type], ...i });
  const incomeCodes = new Set(Object.values(FAMILIES).map((f) => f.income));

  for (const d of docs) {
    if (d.kind !== "invoice") continue;
    const base = { contact: d.contactName, invoice: d.number, date: d.date };
    const iiaLines = d.lines.map((l) => ({ l, acc: iiaAccount(l.AccountCode, accounts) })).filter((x) => x.acc);

    if (isNil(d)) {
      const coded = d.lines.filter((l) => l.AccountCode && cents(l.LineAmount ?? 0) !== 0);
      if (!coded.length) {
        if (/contra|realloc/i.test(`${d.reference ?? ""} ${d.lines.map((l) => l.Description).join(" ")}`)) {
          add("empty_contra", { ...base, detail: `Contra "${d.reference ?? ""}" has no amounts or accounts, so nothing was moved to income.` });
        }
        continue;
      }
      if (!iiaLines.length) continue;
      const taxed = d.lines.filter((l) => l.AccountCode && (l.TaxType !== "BASEXCLUDED" || cents(l.TaxAmount ?? 0) !== 0));
      if (taxed.length) {
        add("contra_has_gst", { ...base, detail: `Contra lines use ${[...new Set(taxed.map((l) => l.TaxType))].join(", ")} instead of BAS Excluded.` });
      }
      const incomeOnInvoice = new Set(d.lines.filter((l) => !iiaAccount(l.AccountCode, accounts)).map((l) => l.AccountCode));
      for (const { l, acc } of iiaLines) {
        if (acc!.income && !incomeOnInvoice.has(acc!.income)) {
          add("contra_wrong_income_account", {
            ...base,
            account: acc!.code,
            amount: -dollars(exGstCents(l, d.lineAmountTypes)),
            detail: `${acc!.code} ${acc!.name} should move to ${acc!.income}; this contra uses ${[...incomeOnInvoice].join(", ") || "no income account"}.`,
          });
        }
      }
      continue;
    }

    if (cents(d.total) <= 0 || !iiaLines.length) continue;
    for (const { l, acc } of iiaLines) {
      for (const p of checkMonthlyLine(l.Description, acc!, accounts).problems) {
        add(p.type, { ...base, account: acc!.code, amount: dollars(exGstCents(l, d.lineAmountTypes)), detail: p.detail });
      }
    }
    // Older packages coded some services straight to income by design; only
    // recent invoices (this and last financial year) are checked.
    if (financialYearOfDate(d.date) < financialYearOfDate(today) - 1) continue;
    for (const l of d.lines) {
      if (l.AccountCode && incomeCodes.has(l.AccountCode)) {
        add("monthly_line_straight_to_income", {
          ...base,
          account: l.AccountCode,
          amount: dollars(exGstCents(l, d.lineAmountTypes)),
          detail: `Package invoice has a line coded straight to ${l.AccountCode} rather than Income in Advance: "${(l.Description ?? "").split(/\r?\n/)[0].slice(0, 60)}".`,
        });
      }
    }
  }

  const balances = buildLedger(docs, accounts);
  const currentFy = financialYearOfDate(today);
  for (const b of balances) {
    const acc = iiaAccount(b.account, accounts)!;
    if (b.balance < -0.5) {
      if (b.invoiced === 0) {
        add("contra_contact_has_no_monthly_invoice", {
          contact: b.contact,
          account: b.account,
          amount: b.reallocated,
          detail: `Contras moved $${b.reallocated.toFixed(2)} out of ${b.account} for this contact, but its monthly invoices are under a different contact. Best practice is the same contact.`,
        });
      } else if (stillBilling(b, today)) {
        // Work done early while the instalments continue: a timing difference.
        add("realised_ahead_of_billing", {
          contact: b.contact,
          account: b.account,
          amount: b.balance,
          detail: `Work realised ahead of billing on ${b.account}: $${(-b.balance).toFixed(2)} ex GST still to be invoiced (last invoiced ${b.lastInvoiceDate}).`,
        });
      } else {
        add("over_reallocated", {
          contact: b.contact,
          account: b.account,
          amount: b.balance,
          detail: `More moved to income ($${b.reallocated.toFixed(2)}) than invoiced ($${b.invoiced.toFixed(2)} less $${b.credited.toFixed(2)} credited) on ${b.account}, and no invoice since ${b.lastInvoiceDate ?? "—"}, so billing seems to have stopped.`,
        });
      }
    } else if (b.balance > 0.5 && acc.year !== null && acc.year <= currentFy - 3) {
      add("old_year_balance", {
        contact: b.contact,
        account: b.account,
        amount: b.balance,
        detail: `$${b.balance.toFixed(2)} still in ${b.account} ${acc.name}: no contra yet, or the work wasn't done.`,
      });
    }
  }

  const order = { error: 0, warning: 1, note: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.type.localeCompare(b.type) || a.contact.localeCompare(b.contact));
  return { issues, balances };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;

async function getWithRetry(client: AxiosInstance, url: string, params: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.get(url, { params });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429 && attempt < 2) {
        const wait = Math.min(Number(err.response.headers?.["retry-after"]) || 30, 60);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw err;
    }
  }
}

interface RawDoc {
  InvoiceID?: string;
  CreditNoteID?: string;
  InvoiceNumber?: string;
  CreditNoteNumber?: string;
  Date?: string;
  Status: string;
  Reference?: string;
  Contact?: { ContactID: string; Name: string };
  Total: number;
  LineAmountTypes?: string;
  LineItems?: XeroLine[];
}

function toDoc(kind: XeroDoc["kind"], r: RawDoc): XeroDoc {
  return {
    kind,
    id: (kind === "invoice" ? r.InvoiceID : r.CreditNoteID) ?? "",
    number: kind === "invoice" ? r.InvoiceNumber : r.CreditNoteNumber,
    date: isoDate(r.Date),
    status: r.Status,
    reference: r.Reference,
    contactId: r.Contact?.ContactID ?? "",
    contactName: r.Contact?.Name ?? "",
    total: r.Total,
    lineAmountTypes: r.LineAmountTypes,
    lines: r.LineItems ?? [],
  };
}

/** Live (not draft, deleted or voided) sales invoices and credit notes. */
export async function fetchSalesDocs(client: AxiosInstance, p: { fromDate?: string; toDate?: string; contactId?: string }): Promise<XeroDoc[]> {
  const docs: XeroDoc[] = [];
  const sources = [
    { kind: "invoice" as const, url: "/Invoices", key: "Invoices", type: "ACCREC" },
    { kind: "creditnote" as const, url: "/CreditNotes", key: "CreditNotes", type: "ACCRECCREDIT" },
  ];
  for (const s of sources) {
    const where = [`Type=="${s.type}"`, 'Status!="DRAFT"', 'Status!="DELETED"', 'Status!="VOIDED"'];
    if (p.contactId) where.push(`Contact.ContactID=Guid("${p.contactId}")`);
    addDateRange(where, p.fromDate, p.toDate);
    for (let page = 1; page <= 200; page++) {
      const res = await getWithRetry(client, s.url, { where: where.join("&&"), page, pageSize: PAGE_SIZE });
      const batch: RawDoc[] = res.data[s.key] ?? [];
      docs.push(...batch.map((r) => toDoc(s.kind, r)));
      // Stop on a short page. (If Xero ignored pageSize, pages are 100 long.)
      if (batch.length < 100) break;
    }
  }
  return docs;
}

async function fetchAccounts(client: AxiosInstance): Promise<XeroAccount[]> {
  const res = await getWithRetry(client, "/Accounts", {});
  return res.data.Accounts ?? [];
}

async function tenantName(tid: string): Promise<string> {
  return (await getTenants()).find((t) => t.tenantId === tid)?.tenantName ?? tid;
}

/** Today's date in Sydney, YYYY-MM-DD. */
export function sydneyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

// ─── Audit tool ──────────────────────────────────────────────────────────────

export async function incomeInAdvanceAudit(p: {
  tenantId?: string;
  fromDate?: string;
  contact?: string;
  account?: string;
  includeBalances?: boolean;
  maxIssues?: number;
}) {
  const tid = await resolveTenantId(p.tenantId);
  const client = await getApiClient(tid);
  const accounts = await fetchAccounts(client);
  const fromDate = p.fromDate ?? "2022-07-01";
  const docs = await fetchSalesDocs(client, { fromDate });
  const { issues, balances } = auditLedger(docs, accounts, sydneyToday());

  const match = (contact: string, account?: string) =>
    (!p.contact || contact.toLowerCase().includes(p.contact.toLowerCase())) && (!p.account || account === p.account);
  const shownIssues = issues.filter((i) => match(i.contact, i.account));
  const shownBalances = balances.filter((b) => match(b.contact, b.account) && Math.abs(b.balance) >= 0.01);

  const byType: Record<string, number> = {};
  for (const i of shownIssues) byType[i.type] = (byType[i.type] ?? 0) + 1;
  const accountTotals: Record<string, number> = {};
  for (const b of balances) accountTotals[`${b.account} ${b.accountName}`] = dollars(cents(accountTotals[`${b.account} ${b.accountName}`] ?? 0) + cents(b.balance));

  const maxIssues = p.maxIssues ?? 150;
  return {
    organisation: await tenantName(tid),
    invoicesFrom: fromDate,
    documentsRead: docs.length,
    contrasRead: docs.filter((d) => isNil(d) && d.lines.some((l) => iiaAccount(l.AccountCode, accounts))).length,
    issueCounts: byType,
    issues: shownIssues.slice(0, maxIssues),
    issuesNotShown: Math.max(0, shownIssues.length - maxIssues),
    accountTotals,
    balances: p.includeBalances || p.contact ? shownBalances : undefined,
    notes: [
      "Balances are ex GST, from sales invoices and credit notes dated on or after invoicesFrom. Manual journals and opening balances are not included, so account totals may differ from the balance sheet.",
      "possible_wrong_year reads the financial year from Ignition's service text; treat it as a prompt to check.",
    ],
  };
}

// ─── Position (liability at a date) ─────────────────────────────────────────

interface ReportRow { RowType?: string; Cells?: { Value?: string; Attributes?: { Id: string; Value: string }[] }[]; Rows?: ReportRow[] }

/** Each account's balance from a Xero Balance Sheet report, by account code. */
export function balanceSheetAmounts(report: { Rows?: ReportRow[] } | null, accounts: XeroAccount[]): Map<string, number> {
  const byId = new Map(accounts.filter((a) => a.AccountID && a.Code).map((a) => [a.AccountID!, a.Code!]));
  const out = new Map<string, number>();
  const walk = (rows: ReportRow[] = []) => {
    for (const r of rows) {
      if (r.RowType === "Row" && r.Cells?.length) {
        const id = r.Cells[0].Attributes?.find((a) => a.Id === "account")?.Value;
        const code = id ? byId.get(id) : undefined;
        if (code) out.set(code, Number(r.Cells[1]?.Value ?? 0) || 0);
      }
      walk(r.Rows);
    }
  };
  walk(report?.Rows);
  return out;
}

export interface PositionRow {
  account: string;
  name: string;
  /** Clients in credit: fees billed for work not yet realised. */
  prepaid: number;
  /** Clients in debit who are still being invoiced: work realised before its instalments were billed. */
  realisedAheadOfBilling: number;
  /**
   * Clients in debit who are no longer being invoiced (or never were, under
   * this contact): not a timing difference, so most likely a contra that was
   * too large, in the wrong year, or under a different contact. To review.
   */
  debitsToReview: number;
  /** prepaid − realisedAheadOfBilling − debitsToReview, from the invoices. */
  net: number;
  /** The account balance on Xero's balance sheet. */
  xeroBalance: number;
  /** xeroBalance − net: manual journals, opening balances or invoices before fromDate. */
  notFromInvoices: number;
}

/** Is a debit balance a timing difference (still being invoiced), as at a date? */
export function stillBilling(b: Balance, asAt: string): boolean {
  return !!b.lastInvoiceDate && daysBetween(b.lastInvoiceDate, asAt) <= STILL_BILLING_DAYS;
}

export function summarisePosition(balances: Balance[], accounts: XeroAccount[], xero: Map<string, number>, asAt: string): { accounts: PositionRow[]; total: Omit<PositionRow, "account" | "name"> } {
  const codes = new Set<string>([...balances.map((b) => b.account), ...[...xero.keys()].filter((c) => iiaAccount(c, accounts))]);
  const rows: PositionRow[] = [...codes].sort().map((code) => {
    let pre = 0;
    let ahead = 0;
    let review = 0;
    for (const b of balances) {
      if (b.account !== code) continue;
      const c = cents(b.balance);
      if (c > 0) pre += c;
      else if (stillBilling(b, asAt)) ahead -= c;
      else review -= c;
    }
    const net = pre - ahead - review;
    const xb = cents(xero.get(code) ?? 0);
    return {
      account: code,
      name: iiaAccount(code, accounts)!.name,
      prepaid: dollars(pre),
      realisedAheadOfBilling: dollars(ahead),
      debitsToReview: dollars(review),
      net: dollars(net),
      xeroBalance: dollars(xb),
      notFromInvoices: dollars(xb - net),
    };
  }).filter((r) => r.prepaid || r.realisedAheadOfBilling || r.debitsToReview || r.xeroBalance);
  const sum = (k: keyof Omit<PositionRow, "account" | "name">) => dollars(rows.reduce((s, r) => s + cents(r[k]), 0));
  return {
    accounts: rows,
    total: {
      prepaid: sum("prepaid"),
      realisedAheadOfBilling: sum("realisedAheadOfBilling"),
      debitsToReview: sum("debitsToReview"),
      net: sum("net"),
      xeroBalance: sum("xeroBalance"),
      notFromInvoices: sum("notFromInvoices"),
    },
  };
}

export async function prepaidIncomePosition(p: { tenantId?: string; asAt?: string; fromDate?: string; contact?: string; includeClients?: boolean; maxClients?: number }) {
  const asAt = p.asAt ?? sydneyToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) throw new Error(`asAt must be YYYY-MM-DD (got "${asAt}").`);
  const fromDate = p.fromDate ?? "2000-01-01";
  const tid = await resolveTenantId(p.tenantId);
  const client = await getApiClient(tid);
  const accounts = await fetchAccounts(client);
  const docs = await fetchSalesDocs(client, { fromDate, toDate: asAt });
  const balances = buildLedger(docs, accounts, asAt);
  const report = (await getWithRetry(client, "/Reports/BalanceSheet", { date: asAt })).data.Reports?.[0] ?? null;
  const position = summarisePosition(balances, accounts, balanceSheetAmounts(report, accounts), asAt);

  const wanted = balances
    .filter((b) => Math.abs(b.balance) >= 0.01 && (!p.contact || b.contact.toLowerCase().includes(p.contact.toLowerCase())))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  const maxClients = p.maxClients ?? 100;
  const showClients = p.includeClients || !!p.contact;

  return {
    organisation: await tenantName(tid),
    asAt,
    prepaidIncomeLiability: position.total.prepaid,
    realisedAheadOfBilling: position.total.realisedAheadOfBilling,
    debitsToReview: position.total.debitsToReview,
    netPerInvoices: position.total.net,
    netPerBalanceSheet: position.total.xeroBalance,
    notFromInvoices: position.total.notFromInvoices,
    byAccount: position.accounts,
    clients: showClients
      ? wanted.slice(0, maxClients).map((b) => ({
          contact: b.contact,
          account: b.account,
          balance: b.balance,
          position: b.balance > 0 ? "prepaid" : stillBilling(b, asAt) ? "realised ahead of billing" : "debit to review",
          invoiced: b.invoiced,
          reallocated: b.reallocated,
          credited: b.credited,
          lastInvoiceDate: b.lastInvoiceDate,
        }))
      : undefined,
    clientsNotShown: showClients ? Math.max(0, wanted.length - maxClients) : undefined,
    notes: [
      "All amounts are ex GST. prepaidIncomeLiability is fees billed for work not yet realised (clients in credit). realisedAheadOfBilling is work realised (contra done) before its instalments were billed, for clients still being invoiced (a timing difference). debitsToReview is clients in debit who haven't been invoiced on that account for over two months: not a timing difference, most likely a contra that was too large, in the wrong year or under a different contact. The balance sheet shows all three netted.",
      "notFromInvoices is the part of the balance sheet figure not explained by sales invoices, credit notes and contras: usually manual journals or opening balances. Those can't be split by client.",
    ],
  };
}

// ─── Detail: what one account is made of ────────────────────────────────────

export interface DetailLine {
  client: string;
  type: "Monthly invoice" | "Credit note" | "Contra";
  invoice: string;
  date: string;
  status: string;
  reference: string;
  service: string;
  /** Effect on the liability, ex GST: + adds (invoices), − takes it down (contras, credit notes). */
  amount: number;
  financialYear: number | null;
  serviceType: string | null;
  check: string;
}

export type Position = "prepaid" | "realised ahead of billing" | "debit to review" | "cleared";

export function positionOf(b: Balance, asAt: string): Position {
  if (b.balance >= 0.005) return "prepaid";
  if (b.balance <= -0.005) return stillBilling(b, asAt) ? "realised ahead of billing" : "debit to review";
  return "cleared";
}

/** Every line in one Income in Advance account, each checked, and each client's position in it. */
export function accountDetail(docs: XeroDoc[], accounts: XeroAccount[], code: string, asAt: string) {
  const acc = iiaAccount(code, accounts);
  if (!acc) throw new Error(`${code} is not an Income in Advance account (804.YY, 805.YY, 806.YY or 804.5).`);

  const lines: (DetailLine & { contactId: string })[] = [];
  for (const d of docs) {
    if (d.date > asAt) continue;
    const contra = isNil(d);
    const incomeOnDoc = new Set(d.lines.filter((l) => !iiaAccount(l.AccountCode, accounts)).map((l) => l.AccountCode));
    for (const l of d.lines) {
      if (l.AccountCode !== code) continue;
      const amt = dollars(exGstCents(l, d.lineAmountTypes));
      const problems: string[] = [];
      let fy: number | null = null;
      let svc: string | null = null;
      if (contra) {
        if (l.TaxType !== "BASEXCLUDED" || cents(l.TaxAmount ?? 0) !== 0) problems.push(`Contra has GST (${l.TaxType}); should be BAS Excluded.`);
        if (acc.income && !incomeOnDoc.has(acc.income)) problems.push(`Moved to ${[...incomeOnDoc].join("/") || "nothing"}; should be ${acc.income}.`);
      } else if (d.kind === "invoice") {
        const c = checkMonthlyLine(l.Description, acc, accounts);
        fy = c.financialYear;
        svc = c.serviceType;
        problems.push(...c.problems.map((p) => p.detail));
      }
      lines.push({
        contactId: d.contactId,
        client: d.contactName,
        type: d.kind === "creditnote" ? "Credit note" : contra ? "Contra" : "Monthly invoice",
        invoice: d.number ?? "",
        date: d.date,
        status: d.status,
        reference: d.reference ?? "",
        service: (l.Description ?? "").split(/\r?\n/)[0].replace(/\s+/g, " ").trim().slice(0, 110),
        amount: d.kind === "creditnote" ? -amt : amt,
        financialYear: fy,
        serviceType: svc,
        check: problems.length ? problems.join(" ") : "OK",
      });
    }
  }
  lines.sort((a, b) => a.client.localeCompare(b.client) || a.date.localeCompare(b.date));

  const flaggedBy = new Map<string, number>();
  for (const l of lines) if (l.check !== "OK") flaggedBy.set(l.contactId, (flaggedBy.get(l.contactId) ?? 0) + 1);

  const clients = buildLedger(docs, accounts, asAt)
    .filter((b) => b.account === code && (Math.abs(b.balance) >= 0.005 || flaggedBy.has(b.contactId)))
    .map((b) => {
      const position = positionOf(b, asAt);
      let comment = "";
      if (position === "debit to review" && b.invoiced === 0) comment = "Contra under this contact; the monthly invoices are under another contact.";
      else if (position === "debit to review") comment = "More moved to income than invoiced, and no longer being invoiced.";
      else if (position === "prepaid" && acc.year !== null && acc.year <= financialYearOfDate(asAt) - 3) comment = "Old year still prepaid: contra not done, or the work wasn't done?";
      return {
        contactId: b.contactId,
        contact: b.contact,
        invoiced: b.invoiced,
        credited: b.credited,
        movedToIncome: b.reallocated,
        balance: b.balance,
        position,
        lastInvoiceDate: b.lastInvoiceDate,
        linesFlagged: flaggedBy.get(b.contactId) ?? 0,
        comment,
      };
    })
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  const sumCents = (f: (c: (typeof clients)[number]) => boolean) => clients.filter(f).reduce((s, c) => s + cents(c.balance), 0);
  const prepaid = sumCents((c) => c.position === "prepaid");
  // 0 − x, not −x, so an empty total is 0 rather than −0.
  const ahead = 0 - sumCents((c) => c.position === "realised ahead of billing");
  const review = 0 - sumCents((c) => c.position === "debit to review");
  return {
    account: acc,
    totals: { prepaid: dollars(prepaid), realisedAheadOfBilling: dollars(ahead), debitsToReview: dollars(review), net: dollars(prepaid - ahead - review) },
    clients,
    lines,
  };
}

export async function incomeInAdvanceDetail(p: { tenantId?: string; account: string; asAt?: string; contact?: string; allLines?: boolean; maxLines?: number }) {
  const asAt = p.asAt ?? sydneyToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAt)) throw new Error(`asAt must be YYYY-MM-DD (got "${asAt}").`);
  const code = p.account?.trim();
  const tid = await resolveTenantId(p.tenantId);
  const client = await getApiClient(tid);
  const accounts = await fetchAccounts(client);
  if (!iiaAccount(code, accounts)) throw new Error(`${code} is not an Income in Advance account (804.YY, 805.YY, 806.YY or 804.5).`);
  const docs = await fetchSalesDocs(client, { toDate: asAt });
  const report = (await getWithRetry(client, "/Reports/BalanceSheet", { date: asAt })).data.Reports?.[0] ?? null;
  const xeroBalance = balanceSheetAmounts(report, accounts).get(code) ?? 0;
  const detail = accountDetail(docs, accounts, code, asAt);

  const forContact = (name: string) => !p.contact || name.toLowerCase().includes(p.contact.toLowerCase());
  const clients = detail.clients.filter((c) => forContact(c.contact));
  // A contact, or allLines: every line. Otherwise just the flagged lines.
  const wanted = detail.lines.filter((l) => forContact(l.client) && (p.contact || p.allLines || l.check !== "OK"));
  const maxLines = p.maxLines ?? (p.contact ? 500 : 200);

  return {
    organisation: await tenantName(tid),
    account: detail.account.code,
    name: detail.account.name,
    asAt,
    ...detail.totals,
    balanceSheet: xeroBalance,
    notFromInvoices: dollars(cents(xeroBalance) - cents(detail.totals.net)),
    linesFlagged: detail.lines.filter((l) => l.check !== "OK" && forContact(l.client)).length,
    clients: clients.map(({ contactId: _id, ...c }) => c),
    lines: wanted.slice(0, maxLines).map(({ contactId: _id, ...l }) => l),
    linesNotShown: Math.max(0, wanted.length - maxLines),
    notes: [
      "Amounts are ex GST. A client's balance = invoiced − credit notes − moved to income (contras). Positions: prepaid (in credit), realised ahead of billing (in debit, still being invoiced), debit to review (in debit, no longer invoiced).",
      p.contact || p.allLines
        ? "lines lists every invoice, credit note and contra line in this account."
        : "lines lists only flagged lines; pass contact (or allLines: true) to see every line.",
      "check tests each line: monthly lines for service type (Tax 804 / Strategy 805 / BAS & BK 806) and financial year; contras for GST and the income account. Services that aren't clearly one type (GST registration, PLSL, TPAR, ASIC, Xero, …) aren't type-checked. It can't tell whether a prepaid job has already reached OFS.",
    ],
  };
}

// ─── Contra invoice tool ─────────────────────────────────────────────────────

export interface ContraLineInput {
  incomeInAdvanceAccount: string;
  amount: number;
  incomeAccount?: string;
  description?: string;
}

export interface ContraInput {
  tenantId?: string;
  contactId?: string;
  contactName?: string;
  date?: string;
  reference: string;
  lines: ContraLineInput[];
  approve?: boolean;
  preview?: boolean;
  /**
   * The job was realised before all its instalments were invoiced, so the
   * contra moves more than has been billed so far. Without this, a contra
   * that takes the balance below zero is refused.
   */
  aheadOfBilling?: boolean;
}

export interface PlannedLine { income: string; iia: IiaAccount; cents: number; description: string }

/** Check the contra lines against the chart of accounts. Throws on a mistake. */
export function planContraLines(lines: ContraLineInput[], accounts: XeroAccount[]): PlannedLine[] {
  if (!lines?.length) throw new Error("Give at least one line.");
  return lines.map((l, i) => {
    const n = `Line ${i + 1}`;
    const iia = iiaAccount(l.incomeInAdvanceAccount?.trim(), accounts);
    if (!iia) throw new Error(`${n}: ${l.incomeInAdvanceAccount} is not an Income in Advance account (804.YY, 805.YY, 806.YY or 804.5).`);
    if (accounts.find((a) => a.Code === iia.code)?.Status !== "ACTIVE") throw new Error(`${n}: ${iia.code} is archived.`);
    const c = cents(l.amount);
    if (!(c > 0)) throw new Error(`${n}: amount must be more than zero (ex GST).`);
    let income = l.incomeAccount?.trim();
    if (iia.income) {
      if (income && income !== iia.income) {
        throw new Error(`${n}: ${iia.code} ${iia.name} must move to ${iia.income}, not ${income}.`);
      }
      income = iia.income;
    } else {
      if (!income) throw new Error(`${n}: ${iia.code} ${iia.name} can move to any income account; say which (incomeAccount).`);
      const acc = accounts.find((a) => a.Code === income);
      if (!acc || acc.Class !== "REVENUE" || acc.Status !== "ACTIVE") throw new Error(`${n}: ${income} is not an active income account.`);
    }
    const description = l.description?.trim() || (iia.year ? `Reallocate ${iia.year} ${iia.label} fee` : "Reallocate fee");
    return { income, iia, cents: c, description };
  });
}

/** The Xero invoice: one income line and one Income in Advance line per input line, all BAS Excluded. */
export function contraInvoicePayload(p: { contactId: string; date: string; reference: string; approve: boolean; lines: PlannedLine[] }) {
  return {
    Type: "ACCREC",
    Contact: { ContactID: p.contactId },
    Date: p.date,
    DueDate: p.date,
    Reference: p.reference,
    LineAmountTypes: "Exclusive",
    Status: p.approve ? "AUTHORISED" : "DRAFT",
    LineItems: p.lines.flatMap((l) => [
      { Description: l.description, Quantity: 1, UnitAmount: dollars(l.cents), AccountCode: l.income, TaxType: "BASEXCLUDED" },
      { Description: l.description, Quantity: 1, UnitAmount: -dollars(l.cents), AccountCode: l.iia.code, TaxType: "BASEXCLUDED" },
    ]),
  };
}

async function findContact(client: AxiosInstance, p: { contactId?: string; contactName?: string }): Promise<{ ContactID: string; Name: string }> {
  if (p.contactId) {
    const res = await getWithRetry(client, `/Contacts/${p.contactId}`, {});
    const c = res.data.Contacts?.[0];
    if (!c) throw new Error(`No contact with ID ${p.contactId}.`);
    return c;
  }
  if (!p.contactName?.trim()) throw new Error("Give contactId or contactName.");
  const name = p.contactName.trim().replace(/"/g, '\\"');
  const res = await getWithRetry(client, "/Contacts", { where: `Name.ToLower()=="${name.toLowerCase()}"` });
  const found: { ContactID: string; Name: string }[] = res.data.Contacts ?? [];
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`${found.length} contacts are called "${p.contactName}"; pass contactId.`);
  throw new Error(`No contact called exactly "${p.contactName}". Use xero_list_contacts to find the name or ID.`);
}

export async function createContraInvoice(p: ContraInput) {
  const date = p.date ?? sydneyToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD (got "${date}").`);
  if (!p.reference?.trim()) throw new Error('reference is required, e.g. "2026 Tax Contra".');
  const approve = p.approve ?? true;

  const tid = await resolveTenantId(p.tenantId);
  const client = await getApiClient(tid);
  const accounts = await fetchAccounts(client);
  const lines = planContraLines(p.lines, accounts);
  const contact = await findContact(client, p);

  // What's left in each account for this contact, before this contra.
  const balances = buildLedger(await fetchSalesDocs(client, { contactId: contact.ContactID }), accounts);
  const requested = new Map<string, number>();
  for (const l of lines) requested.set(l.iia.code, (requested.get(l.iia.code) ?? 0) + l.cents);
  const check = [...requested].map(([code, c]) => {
    const before = cents(balances.find((b) => b.account === code)?.balance ?? 0);
    return { account: code, balanceBefore: dollars(before), moving: dollars(c), balanceAfter: dollars(before - c) };
  });
  const short = check.filter((c) => c.balanceAfter < 0);
  if (short.length && !p.aheadOfBilling) {
    throw new Error(
      short
        .map((s) => `${contact.Name} has $${s.balanceBefore.toFixed(2)} ex GST left in ${s.account}, less than the $${s.moving.toFixed(2)} to move.`)
        .join(" ") +
        " Check the amount, the account year, and that the monthly invoices are under this same contact." +
        " If the job was done before all its instalments were invoiced, call again with aheadOfBilling: true."
    );
  }
  const stillToInvoice = short.map((s) => ({ account: s.account, amount: -s.balanceAfter }));

  const organisation = await tenantName(tid);
  const payload = contraInvoicePayload({ contactId: contact.ContactID, date, reference: p.reference.trim(), approve, lines });
  const summary = {
    organisation,
    contact: contact.Name,
    date,
    reference: payload.Reference,
    lines: lines.map((l) => ({ from: l.iia.code, to: l.income, amount: dollars(l.cents), description: l.description })),
    tax: "BAS Excluded on every line; nil total",
    balances: check,
    ...(stillToInvoice.length
      ? { realisedAheadOfBilling: stillToInvoice, note: "Work realised ahead of billing: these amounts (ex GST) are still to come on the remaining instalments." }
      : {}),
  };
  if (p.preview) return { preview: true, wouldCreate: approve ? "approved (auto-paid) nil-total invoice" : "draft nil-total invoice", ...summary };

  let created: { InvoiceID: string; InvoiceNumber: string; Status: string; Total: number } | undefined;
  try {
    const res = await client.put("/Invoices", { Invoices: [payload] });
    created = res.data.Invoices?.[0];
  } catch (err) {
    throw new Error(xeroErrorMessage(err, "contra invoice"));
  }
  if (!created) throw new Error("Xero did not return the created invoice.");
  console.log(`WRITE contra invoice ${created.InvoiceNumber} (${created.Status}) for "${contact.Name}" in "${organisation}"`);
  return { invoiceNumber: created.InvoiceNumber, invoiceId: created.InvoiceID, status: created.Status, total: created.Total, ...summary };
}
