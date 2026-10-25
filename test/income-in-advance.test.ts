import { test, describe, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import {
  iiaAccount,
  financialYearOf,
  financialYearOfDate,
  buildLedger,
  summarisePosition,
  balanceSheetAmounts,
  serviceFamily,
  checkMonthlyLine,
  accountDetail,
  auditLedger,
  planContraLines,
  contraInvoicePayload,
  createContraInvoice,
  XeroDoc,
  XeroAccount,
} from "../src/income-in-advance.js";
import { listInvoices } from "../src/xero-client.js";

const ACCOUNTS: XeroAccount[] = [
  { Code: "200", Name: "Income - Tax Returns & Financial Statements", Status: "ACTIVE", Class: "REVENUE" },
  { Code: "202", Name: "Income - BAS & Bookkeeping", Status: "ACTIVE", Class: "REVENUE" },
  { Code: "204", Name: "Income - Strategy & Advice", Status: "ACTIVE", Class: "REVENUE" },
  { Code: "206", Name: "Income - Administration and Adhoc", Status: "ACTIVE", Class: "REVENUE" },
  { Code: "800", Name: "Trade Creditors", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "804.23", Name: "Income in Advance - Tax (2023)", Status: "ARCHIVED", Class: "LIABILITY" },
  { Code: "804.24", Name: "Income in Advance - Tax (2024)", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "804.25", Name: "Income in Advance - Tax (2025)", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "804.26", Name: "Income in Advance - Tax (2026)", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "804.5", Name: "Income in Advance - Other", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "804.6", Name: "Get Started Fees Held", Status: "ARCHIVED", Class: "LIABILITY" },
  { Code: "805.26", Name: "Income in Advance - Strategy Appointments (2026)", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "806.25", Name: "Income in Advance - BAS & BK (2025)", Status: "ACTIVE", Class: "LIABILITY" },
  { Code: "806.26", Name: "Income in Advance - BAS & BK (2026)", Status: "ACTIVE", Class: "LIABILITY" },
];

let n = 0;
function inv(p: Partial<XeroDoc> & { lines: XeroDoc["lines"] }): XeroDoc {
  const total = p.total ?? p.lines.reduce((s, l) => s + (l.LineAmount ?? 0) + (p.lineAmountTypes === "Exclusive" ? l.TaxAmount ?? 0 : 0), 0);
  return { kind: "invoice", id: `id${++n}`, number: `INV-${n}`, date: "2026-03-01", status: "PAID", contactId: "c1", contactName: "Client One", lineAmountTypes: "Inclusive", ...p, total };
}
const monthly = (code: string, amountIncGst: number, description = "", extra: Partial<XeroDoc> = {}) =>
  inv({ ...extra, lines: [{ AccountCode: code, LineAmount: amountIncGst, TaxAmount: Math.round((amountIncGst / 11) * 100) / 100, TaxType: "OUTPUT", Description: description }] });
const contra = (from: string, to: string, amount: number, extra: Partial<XeroDoc> = {}, taxType = "BASEXCLUDED") =>
  inv({
    ...extra,
    reference: "2026 Tax Contra",
    lines: [
      { AccountCode: to, LineAmount: amount, TaxAmount: 0, TaxType: taxType },
      { AccountCode: from, LineAmount: -amount, TaxAmount: 0, TaxType: taxType },
    ],
  });

describe("accounts and years", () => {
  test("Income in Advance accounts and their income account", () => {
    assert.deepEqual(
      { ...iiaAccount("804.26", ACCOUNTS) },
      { code: "804.26", name: "Income in Advance - Tax (2026)", year: 2026, income: "200", label: "Tax" }
    );
    assert.equal(iiaAccount("805.26", ACCOUNTS)?.income, "204");
    assert.equal(iiaAccount("806.26", ACCOUNTS)?.income, "202");
    assert.equal(iiaAccount("804.5", ACCOUNTS)?.income, null);
    assert.equal(iiaAccount("804.5", ACCOUNTS)?.year, null);
    assert.equal(iiaAccount("804.6", ACCOUNTS), null, "Get Started Fees Held is not Income in Advance");
    assert.equal(iiaAccount("800", ACCOUNTS), null);
  });

  test("financial year from Ignition's service text", () => {
    assert.equal(financialYearOf("2026 Individual Tax Return Communicate with you"), 2026);
    assert.equal(financialYearOf("2025 BAS Quarterly Lodgement - December We will prepare"), 2026);
    assert.equal(financialYearOf("2026 BAS Quarterly Lodgement - March"), 2026);
    assert.equal(financialYearOf("2025 BAS Quarterly Lodgement - June"), 2025);
    assert.equal(financialYearOf("2025 Strategy Session Quarterly - September"), 2026);
    assert.equal(financialYearOf("Rental Schedule You have indicated"), null);
    assert.equal(financialYearOfDate("2026-10-26"), 2027);
    assert.equal(financialYearOfDate("2026-06-30"), 2026);
  });
});

describe("service type", () => {
  test("type from the service text", () => {
    assert.equal(serviceFamily("2026 BAS Quarterly Lodgement - June We will prepare"), "806");
    assert.equal(serviceFamily("2026 IAS Monthly Lodgement - March"), "806");
    assert.equal(serviceFamily("Payroll & Superannuation Processing"), "806");
    assert.equal(serviceFamily("2025 Strategy Session Quarterly - December"), "805");
    assert.equal(serviceFamily("Business Advisory - March Quarter 2026"), "805");
    assert.equal(serviceFamily("2026 Trust Financial Statements + Trust Tax Return"), "804");
    assert.equal(serviceFamily("2025 Individual Tax Return + Business Schedule + GST Reconciliation"), "804");
    assert.equal(serviceFamily("Rental Schedule You have indicated"), "804");
    assert.equal(serviceFamily("GST Registration"), null);
    assert.equal(serviceFamily("Taxable Payments Annual Report (TPAR)"), null);
  });

  test("a BAS line in a Tax account is the wrong type", () => {
    const r = checkMonthlyLine("2026 BAS Quarterly Lodgement - June", iiaAccount("804.26", ACCOUNTS)!, ACCOUNTS);
    assert.deepEqual(r.problems.map((p) => p.type), ["wrong_service_type"]);
    assert.match(r.problems[0].detail, /belongs in 806\.26/);
    assert.equal(r.serviceType, "BAS & BK");
  });

  test("wrong year points at that year's account of the right type", () => {
    const r = checkMonthlyLine("2025 BAS Quarterly Lodgement - December", iiaAccount("806.25", ACCOUNTS)!, ACCOUNTS);
    assert.deepEqual(r.problems.map((p) => p.type), ["possible_wrong_year"]);
    assert.match(r.problems[0].detail, /belongs in 806\.26/);
  });

  test("correct lines and unclassified services raise nothing; 804.5 isn't checked", () => {
    assert.deepEqual(checkMonthlyLine("2026 Individual Tax Return", iiaAccount("804.26", ACCOUNTS)!, ACCOUNTS).problems, []);
    assert.deepEqual(checkMonthlyLine("GST Registration", iiaAccount("806.26", ACCOUNTS)!, ACCOUNTS).problems, []);
    assert.deepEqual(checkMonthlyLine("2024 BAS Quarterly Lodgement - June", iiaAccount("804.5", ACCOUNTS)!, ACCOUNTS).problems, []);
  });
});

describe("ledger", () => {
  test("ex-GST balance per contact and account", () => {
    const docs = [
      monthly("804.26", 110),
      monthly("804.26", 110),
      contra("804.26", "200", 150),
      { ...monthly("804.26", 22), kind: "creditnote" as const },
    ];
    const [b] = buildLedger(docs, ACCOUNTS);
    assert.equal(b.invoiced, 200);
    assert.equal(b.reallocated, 150);
    assert.equal(b.credited, 20);
    assert.equal(b.balance, 30);
  });

  test("as at a date ignores later documents", () => {
    const docs = [monthly("804.26", 110, "", { date: "2026-01-01" }), monthly("804.26", 110, "", { date: "2026-02-01" }), contra("804.26", "200", 150, { date: "2026-03-01" })];
    assert.equal(buildLedger(docs, ACCOUNTS, "2026-01-31")[0].balance, 100);
    assert.equal(buildLedger(docs, ACCOUNTS, "2026-02-28")[0].balance, 200);
    assert.equal(buildLedger(docs, ACCOUNTS, "2026-03-01")[0].balance, 50);
    assert.equal(buildLedger(docs, ACCOUNTS, "2026-03-01")[0].lastInvoiceDate, "2026-02-01");
  });
});

describe("position", () => {
  const ACC = ACCOUNTS.map((a, i) => ({ ...a, AccountID: `acc-${i}` }));
  const id = (code: string) => ACC.find((a) => a.Code === code)!.AccountID!;

  test("prepaid, realised ahead of billing, debits to review, reconciled to the balance sheet", () => {
    const docs = [
      // Client One: prepaid $300 on 804.26.
      monthly("804.26", 330, "", { date: "2026-09-01" }),
      // Client Two: work done early, still being invoiced → timing difference of $500.
      monthly("806.26", 550, "", { date: "2026-10-01", contactId: "c2", contactName: "Two" }),
      contra("806.26", "202", 1000, { date: "2026-10-05", contactId: "c2", contactName: "Two" }),
      // Client Three: billing stopped in March, contra too large → $200 to review.
      monthly("806.26", 110, "", { date: "2026-03-01", contactId: "c3", contactName: "Three" }),
      contra("806.26", "202", 300, { date: "2026-04-01", contactId: "c3", contactName: "Three" }),
    ];
    const report = {
      Rows: [{ RowType: "Section", Rows: [
        { RowType: "Row", Cells: [{ Value: "Income in Advance - Tax (2026)", Attributes: [{ Id: "account", Value: id("804.26") }] }, { Value: "350.00" }] },
        { RowType: "Row", Cells: [{ Value: "Income in Advance - BAS & BK (2026)", Attributes: [{ Id: "account", Value: id("806.26") }] }, { Value: "-700.00" }] },
      ] }],
    };
    const xero = balanceSheetAmounts(report, ACC);
    assert.equal(xero.get("804.26"), 350);
    const { accounts, total } = summarisePosition(buildLedger(docs, ACC, "2026-10-26"), ACC, xero, "2026-10-26");
    const tax = accounts.find((a) => a.account === "804.26")!;
    assert.deepEqual([tax.prepaid, tax.net, tax.xeroBalance, tax.notFromInvoices], [300, 300, 350, 50]);
    const bas = accounts.find((a) => a.account === "806.26")!;
    assert.deepEqual([bas.prepaid, bas.realisedAheadOfBilling, bas.debitsToReview, bas.net, bas.notFromInvoices], [0, 500, 200, -700, 0]);
    assert.deepEqual(total, { prepaid: 300, realisedAheadOfBilling: 500, debitsToReview: 200, net: -400, xeroBalance: -350, notFromInvoices: 50 });
  });
});

describe("account detail", () => {
  test("lines, checks, client positions and totals for one account", () => {
    const docs = [
      monthly("804.26", 330, "2026 Individual Tax Return", { date: "2026-09-01", number: "INV-A" }),
      monthly("804.26", 44, "2026 BAS Quarterly Lodgement - June", { date: "2026-09-01", number: "INV-B" }),
      monthly("804.26", 110, "2026 Company Tax Return", { date: "2026-03-01", contactId: "c3", contactName: "Three" }),
      contra("804.26", "202", 300, { date: "2026-04-01", contactId: "c3", contactName: "Three", number: "INV-C" }),
      monthly("806.26", 999, "2026 BAS", { date: "2026-09-01" }),
    ];
    const d = accountDetail(docs, ACCOUNTS, "804.26", "2026-10-26");
    assert.equal(d.lines.length, 4, "only lines in 804.26 (a contra has one line here, one in income)");
    const bas = d.lines.find((l) => l.invoice === "INV-B")!;
    assert.match(bas.check, /belongs in 806\.26/);
    assert.equal(d.lines.find((l) => l.invoice === "INV-A")!.check, "OK");
    const contraLines = d.lines.filter((l) => l.invoice === "INV-C");
    assert.equal(contraLines[0].type, "Contra");
    assert.match(contraLines[0].check, /should be 200/);
    assert.equal(contraLines[0].amount, -300);

    const one = d.clients.find((c) => c.contact === "Client One")!;
    assert.deepEqual([one.balance, one.position, one.linesFlagged], [340, "prepaid", 1]);
    const three = d.clients.find((c) => c.contact === "Three")!;
    assert.deepEqual([three.balance, three.position, three.linesFlagged], [-200, "debit to review", 1]);
    assert.deepEqual(d.totals, { prepaid: 340, realisedAheadOfBilling: 0, debitsToReview: 200, net: 140 });
  });

  test("refuses an account that isn't Income in Advance", () => {
    assert.throws(() => accountDetail([], ACCOUNTS, "200", "2026-10-26"), /not an Income in Advance account/);
  });
});

describe("audit", () => {
  const types = (docs: XeroDoc[]) => auditLedger(docs, ACCOUNTS, "2026-10-26").issues.map((i) => i.type);

  test("a correct package and contra raise nothing", () => {
    assert.deepEqual(types([monthly("804.26", 1100, "2026 Individual Tax Return"), contra("804.26", "200", 1000)]), []);
  });

  test("contra with GST", () => {
    assert.ok(types([monthly("804.26", 1100), contra("804.26", "200", 1000, {}, "OUTPUT")]).includes("contra_has_gst"));
  });

  test("empty contra", () => {
    const empty = inv({ reference: "September 2025 Strategy Contra", lines: [{ LineAmount: 0, Description: "Reallocate Strat fee" }] });
    assert.deepEqual(types([empty]), ["empty_contra"]);
  });

  test("contra to the wrong income account", () => {
    assert.ok(types([monthly("806.26", 1100), contra("806.26", "200", 1000)]).includes("contra_wrong_income_account"));
  });

  test("804.5 Other may go to any income account", () => {
    assert.deepEqual(types([monthly("804.5", 1100), contra("804.5", "206", 1000)]), []);
  });

  test("a debit while still being invoiced is a timing difference, not an error", () => {
    const t = types([monthly("806.26", 110, "", { date: "2026-10-01" }), contra("806.26", "202", 500, { date: "2026-10-05" })]);
    assert.deepEqual(t, ["realised_ahead_of_billing"]);
  });

  test("over-reallocated, and a contra under a different contact", () => {
    assert.ok(types([monthly("804.26", 110), contra("804.26", "200", 500)]).includes("over_reallocated"));
    const t = types([monthly("804.26", 1100), contra("804.26", "200", 1000, { contactId: "c2", contactName: "Other Entity" })]);
    assert.ok(t.includes("contra_contact_has_no_monthly_invoice"));
    assert.ok(!t.includes("over_reallocated"));
  });

  test("possible wrong year only when that year's account exists", () => {
    assert.ok(types([monthly("804.25", 110, "2024 Trust Financial Statements + Trust Tax Return")]).includes("possible_wrong_year"));
    assert.ok(!types([monthly("804.24", 110, "2021 Individual Tax Return")]).includes("possible_wrong_year"));
  });

  test("old-year balances (three or more years back) are flagged", () => {
    assert.ok(types([monthly("804.24", 110)]).includes("old_year_balance"));
    assert.ok(!types([monthly("804.25", 110)]).includes("old_year_balance"));
  });

  test("recent package lines coded straight to income are noted; old ones aren't", () => {
    const mixed = (date: string) => inv({ date, lines: [{ AccountCode: "804.26", LineAmount: 110, TaxAmount: 10 }, { AccountCode: "204", LineAmount: 55, TaxAmount: 5 }] });
    assert.ok(types([mixed("2026-03-01")]).includes("monthly_line_straight_to_income"));
    assert.ok(!types([mixed("2023-03-01")]).includes("monthly_line_straight_to_income"));
  });
});

describe("contra lines", () => {
  test("income account comes from the Income in Advance account", () => {
    const [l] = planContraLines([{ incomeInAdvanceAccount: "806.26", amount: 354.52 }], ACCOUNTS);
    assert.equal(l.income, "202");
    assert.equal(l.cents, 35452);
    assert.equal(l.description, "Reallocate 2026 BAS & BK fee");
  });

  test("mistakes are refused", () => {
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "806.26", amount: 10, incomeAccount: "200" }], ACCOUNTS), /must move to 202/);
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "804.5", amount: 10 }], ACCOUNTS), /say which/);
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "804.5", amount: 10, incomeAccount: "800" }], ACCOUNTS), /not an active income account/);
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "804.23", amount: 10 }], ACCOUNTS), /archived/);
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "200", amount: 10 }], ACCOUNTS), /not an Income in Advance account/);
    assert.throws(() => planContraLines([{ incomeInAdvanceAccount: "804.26", amount: 0 }], ACCOUNTS), /more than zero/);
  });

  test("the invoice is nil-total, BAS Excluded, approved", () => {
    const lines = planContraLines([{ incomeInAdvanceAccount: "804.26", amount: 900 }, { incomeInAdvanceAccount: "805.26", amount: 100.1 }], ACCOUNTS);
    const p = contraInvoicePayload({ contactId: "c1", date: "2026-10-26", reference: "2026 Tax Contra", approve: true, lines });
    assert.equal(p.Status, "AUTHORISED");
    assert.equal(p.LineItems.length, 4);
    assert.ok(p.LineItems.every((l) => l.TaxType === "BASEXCLUDED"));
    assert.equal(Math.round(p.LineItems.reduce((s, l) => s + l.UnitAmount * 100, 0)), 0);
    assert.deepEqual(p.LineItems.map((l) => l.AccountCode), ["200", "804.26", "204", "805.26"]);
  });
});

describe("Xero calls (faked)", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";
  let get: ReturnType<typeof mock.fn>;
  let put: ReturnType<typeof mock.fn>;
  const rawInvoice = (code: string, amt: number, tax: number) => ({
    InvoiceID: "x", InvoiceNumber: "INV-1", Date: "/Date(1772323200000+0000)/", Status: "PAID", Total: amt,
    Contact: { ContactID: "c1", Name: "Client One" }, LineAmountTypes: "Inclusive",
    LineItems: [{ AccountCode: code, LineAmount: amt, TaxAmount: tax, TaxType: "OUTPUT" }],
  });

  before(() => {
    process.env.XERO_CLIENT_ID = "test";
    process.env.XERO_CLIENT_SECRET = "test";
    delete process.env.XERO_OAUTH_CLIENT_ID;
    mock.method(axios, "post", async () => ({ data: { access_token: "tok", expires_in: 1800 } }));
    mock.method(axios, "get", async () => ({ data: [{ tenantId: TENANT, tenantName: "Dream Accounting", tenantType: "ORGANISATION" }] }));
  });

  beforeEach(() => {
    get = mock.fn(async (url: string) => {
      if (url === "/Accounts") return { data: { Accounts: ACCOUNTS } };
      if (url === "/Contacts") return { data: { Contacts: [{ ContactID: "c1", Name: "Client One" }] } };
      if (url === "/Invoices") return { data: { Invoices: [rawInvoice("804.26", 1100, 100)] } };
      if (url === "/CreditNotes") return { data: { CreditNotes: [] } };
      throw new Error(`unexpected GET ${url}`);
    });
    put = mock.fn(async (_url: string, body: { Invoices: object[] }) => ({
      data: { Invoices: [{ InvoiceID: "new", InvoiceNumber: "INV-99", Status: "PAID", Total: 0, ...body.Invoices[0] }] },
    }));
    mock.method(axios, "create", () => ({ get, put }));
  });

  const quietly = async <T>(f: () => Promise<T>) => {
    const log = console.log;
    console.log = () => {};
    try { return await f(); } finally { console.log = log; }
  };

  test("creates an approved, BAS Excluded contra within the balance", async () => {
    const r = await quietly(() => createContraInvoice({ tenantId: TENANT, contactName: "Client One", reference: "2026 Tax Contra", date: "2026-10-26", lines: [{ incomeInAdvanceAccount: "804.26", amount: 1000 }] }));
    assert.equal(put.mock.callCount(), 1);
    const [url, body] = put.mock.calls[0].arguments as [string, { Invoices: { Status: string; LineItems: { TaxType: string }[] }[] }];
    assert.equal(url, "/Invoices");
    assert.equal(body.Invoices[0].Status, "AUTHORISED");
    assert.ok(body.Invoices[0].LineItems.every((l) => l.TaxType === "BASEXCLUDED"));
    assert.equal(r.invoiceNumber, "INV-99");
    assert.equal(r.organisation, "Dream Accounting");
    assert.deepEqual(r.balances, [{ account: "804.26", balanceBefore: 1000, moving: 1000, balanceAfter: 0 }]);
    // The contact's invoices were read with a contact filter and no drafts/voided.
    const where = (get.mock.calls.find((c) => c.arguments[0] === "/Invoices")!.arguments[1] as { params: { where: string } }).params.where;
    assert.match(where, /Contact\.ContactID=Guid\("c1"\)/);
    assert.match(where, /Status!="VOIDED"/);
  });

  test("refuses to move more than the balance, without calling Xero to create", async () => {
    await assert.rejects(
      createContraInvoice({ tenantId: TENANT, contactName: "Client One", reference: "x", lines: [{ incomeInAdvanceAccount: "804.26", amount: 1000.01 }] }),
      /has \$1000\.00 ex GST left in 804\.26.*aheadOfBilling: true/
    );
    assert.equal(put.mock.callCount(), 0);
  });

  test("aheadOfBilling allows moving the full fee before it's all billed", async () => {
    const r = await quietly(() =>
      createContraInvoice({ tenantId: TENANT, contactName: "Client One", reference: "x", aheadOfBilling: true, lines: [{ incomeInAdvanceAccount: "804.26", amount: 1500 }] })
    );
    assert.equal(put.mock.callCount(), 1);
    assert.deepEqual((r as { realisedAheadOfBilling?: unknown }).realisedAheadOfBilling, [{ account: "804.26", amount: 500 }]);
  });

  test("preview creates nothing", async () => {
    const r = await createContraInvoice({ tenantId: TENANT, contactName: "Client One", reference: "x", preview: true, lines: [{ incomeInAdvanceAccount: "804.26", amount: 500 }] });
    assert.equal(put.mock.callCount(), 0);
    assert.equal((r as { preview?: boolean }).preview, true);
  });

  test("date filters go in the where clause", async () => {
    await listInvoices({ tenantId: TENANT, dateFrom: "2025-07-01", dateTo: "2026-06-30" });
    const params = (get.mock.calls.at(-1)!.arguments[1] as { params: Record<string, string> }).params;
    assert.match(params.where, /Date>=DateTime\(2025,7,1\)/);
    assert.match(params.where, /Date<=DateTime\(2026,6,30\)/);
    assert.equal(params.fromDate, undefined);
  });
});
