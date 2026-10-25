import { test, describe, before, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { buildManualJournalPayload, createDraftManualJournal } from "../src/xero-client.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const balanced = [
  { accountCode: "400", debit: 1200.5 },
  { accountCode: "800", credit: 1000 },
  { accountCode: "810", credit: 200.5, description: "Split" },
];

describe("buildManualJournalPayload", () => {
  test("debits become positive and credits negative; status is always DRAFT", () => {
    const p = buildManualJournalPayload({ date: "2026-06-30", narration: " Year-end ", lines: balanced });
    assert.equal(p.Status, "DRAFT");
    assert.equal(p.Narration, "Year-end");
    assert.equal(p.LineAmountTypes, "NoTax");
    assert.deepEqual(p.JournalLines.map((l) => l.LineAmount), [1200.5, -1000, -200.5]);
    assert.equal(p.JournalLines[2].Description, "Split");
  });

  test("tracking is mapped to Xero's shape", () => {
    const p = buildManualJournalPayload({
      date: "2026-06-30",
      narration: "x",
      lines: [
        { accountCode: "400", debit: 10, tracking: [{ name: "Region", option: "North" }] },
        { accountCode: "800", credit: 10 },
      ],
    });
    assert.deepEqual(p.JournalLines[0].Tracking, [{ Name: "Region", Option: "North" }]);
  });

  test("rejects an unbalanced journal", () => {
    assert.throws(
      () => buildManualJournalPayload({ date: "2026-06-30", narration: "x", lines: [{ accountCode: "400", debit: 100 }, { accountCode: "800", credit: 99.99 }] }),
      /does not balance: debits minus credits = 0.01/
    );
  });

  test("floating-point amounts that balance to the cent are accepted", () => {
    const p = buildManualJournalPayload({
      date: "2026-06-30",
      narration: "x",
      lines: [{ accountCode: "1", debit: 0.1 }, { accountCode: "2", debit: 0.2 }, { accountCode: "3", credit: 0.3 }],
    });
    assert.equal(p.JournalLines.length, 3);
  });

  test("rejects a line with both or neither of debit and credit", () => {
    assert.throws(() => buildManualJournalPayload({ date: "2026-06-30", narration: "x", lines: [{ accountCode: "1", debit: 5, credit: 5 }, { accountCode: "2", credit: 0 }] }), /Line 1/);
    assert.throws(() => buildManualJournalPayload({ date: "2026-06-30", narration: "x", lines: [{ accountCode: "1", debit: 5 }, { accountCode: "2" }] }), /Line 2/);
  });

  test("rejects bad dates, missing narration and single-line journals", () => {
    assert.throws(() => buildManualJournalPayload({ date: "30/06/2026", narration: "x", lines: balanced }), /YYYY-MM-DD/);
    assert.throws(() => buildManualJournalPayload({ date: "2026-06-30", narration: "  ", lines: balanced }), /narration/);
    assert.throws(() => buildManualJournalPayload({ date: "2026-06-30", narration: "x", lines: [{ accountCode: "1", debit: 0 }] }), /two lines/);
  });

  test("with tax, balancing is left to Xero", () => {
    const p = buildManualJournalPayload({
      date: "2026-06-30",
      narration: "x",
      lineAmountTypes: "Exclusive",
      lines: [{ accountCode: "400", debit: 100, taxType: "INPUT" }, { accountCode: "800", credit: 110 }],
    });
    assert.equal(p.LineAmountTypes, "Exclusive");
    assert.equal(p.JournalLines[0].TaxType, "INPUT");
  });
});

describe("createDraftManualJournal (Xero faked)", () => {
  let put: ReturnType<typeof mock.fn>;
  const quiet = console.log;

  before(() => {
    process.env.XERO_CLIENT_ID = "test";
    process.env.XERO_CLIENT_SECRET = "test";
    delete process.env.XERO_OAUTH_CLIENT_ID;
    mock.method(axios, "post", async () => ({ data: { access_token: "tok", expires_in: 1800 } }));
    mock.method(axios, "get", async () => ({ data: [{ tenantId: TENANT, tenantName: "Test Client Pty Ltd", tenantType: "ORGANISATION" }] }));
  });
  afterEach(() => { console.log = quiet; });

  function fakeClient(impl: (url: string, body: unknown) => Promise<unknown>) {
    put = mock.fn(impl);
    mock.method(axios, "create", () => ({ put }));
    console.log = () => {};
  }

  test("PUTs one DRAFT journal and returns the organisation name", async () => {
    fakeClient(async () => ({
      data: { ManualJournals: [{ ManualJournalID: "mj-1", Status: "DRAFT", Date: "/Date(1782777600000)/", Narration: "Year-end" }] },
    }));
    const r = await createDraftManualJournal({ tenantId: TENANT, date: "2026-06-30", narration: "Year-end", lines: balanced });

    assert.equal(put.mock.callCount(), 1);
    const [url, body] = put.mock.calls[0].arguments as [string, { ManualJournals: { Status: string }[] }];
    assert.equal(url, "/ManualJournals");
    assert.equal(body.ManualJournals.length, 1);
    assert.equal(body.ManualJournals[0].Status, "DRAFT");
    assert.equal(r.organisation, "Test Client Pty Ltd");
    assert.equal(r.manualJournalId, "mj-1");
    assert.equal(r.status, "DRAFT");
    assert.equal(r.totalDebits, 1200.5);
  });

  test("an unbalanced journal never reaches Xero", async () => {
    fakeClient(async () => ({ data: {} }));
    await assert.rejects(
      createDraftManualJournal({ tenantId: TENANT, date: "2026-06-30", narration: "x", lines: [{ accountCode: "1", debit: 5 }, { accountCode: "2", credit: 4 }] }),
      /does not balance/
    );
    assert.equal(put.mock.callCount(), 0);
  });

  test("Xero validation errors are shown in plain words", async () => {
    fakeClient(async () => {
      throw {
        isAxiosError: true,
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            Message: "A validation exception occurred",
            Elements: [{ ValidationErrors: [], JournalLines: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code for this document." }] }] }],
          },
        },
      };
    });
    await assert.rejects(
      createDraftManualJournal({ tenantId: TENANT, date: "2026-06-30", narration: "x", lines: [{ accountCode: "999", debit: 5 }, { accountCode: "800", credit: 5 }] }),
      /Xero rejected the journal: Account code '999' is not a valid code/
    );
  });
});
