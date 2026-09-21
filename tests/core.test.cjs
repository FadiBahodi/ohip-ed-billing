const test = require("node:test"),
  assert = require("node:assert/strict");
const D = require("../engine/data.js"),
  F = require("../engine/fastbill.js"),
  V = require("../engine/validator.js"),
  C = require("../core.js");
const analyze = (note, ctx = {}, ledger = []) =>
  F.analyze(note, { encounterId: "E-test", overrides: {}, ...ctx }, D, ledger);
const codes = (x) => x.result.items.map((x) => x.code);
const base = "PIA: 2026-09-18 16:50\nMinor assessment. ";
test("declined procedure and negated critical care do not become claims", () => {
  const a = analyze(
    base +
      "Abscess. Incision and drainage offered; patient declined. No critical care provided. Note signed 19:00.",
  );
  assert.deepEqual(codes(a), ["H101"]);
  assert.equal(a.facts.time, "16:50");
  assert.equal(a.facts.critical.tier, "none");
});
test("another physician central line cannot become my procedure", () => {
  const a = analyze(
    base +
      "Central line inserted by ICU physician. I did not perform the procedure.",
  );
  assert(!codes(a).includes("G269"));
});
test("time bands follow physician assessment, not note signing", () => {
  assert.deepEqual(codes(analyze(base + "Assessed 1650. Note signed 1900.")), [
    "H101",
  ]);
  assert.equal(V.assessment("2026-09-18", "17:00", "minor", false), "H151");
});
test("missing time and missing descriptor remain questions", () => {
  const a = analyze("SYNTHETIC CASE: assessed patient with cough.");
  assert(a.result.questions.some((q) => q.field === "time"));
  assert(!codes(a).some((c) => /^H1/.test(c)));
});
test("exclusive critical time aggregates before rounding", () => {
  const a = analyze(
    "PIA: 28/08/26 00:05\nAcute respiratory failure. I initiated BiPAP. Life-threatening critical care; exclusive physician care excluding procedures. Critical care 00:05–00:21; 01:10–01:20; 01:40–01:47.",
  );
  assert.equal(a.result.criticalMinutes, 33);
  for (const c of ["G521", "G523", "G522"]) assert(codes(a).includes(c));
  assert(!a.result.items.some((i) => i.reason.includes("Assessment matched")));
});
test("overlapping critical time between encounters blocks review", () => {
  const a = analyze(
    "PIA: 2026-09-18 00:05\nAcute respiratory failure. I initiated BiPAP. Life-threatening critical care. Exclusive critical care 00:05–00:21.",
  );
  const b = analyze(
    "PIA: 2026-09-18 00:10\nAcute respiratory failure. I initiated BiPAP. Life-threatening critical care. Exclusive critical care 00:10–00:25.",
    {},
    [{ encounterId: "other", criticalIntervals: a.result.criticalIntervals }],
  );
  assert(b.result.blockers.some((s) => s.includes("overlaps")));
});
test("bundled cast and local block are not added to fracture treatment", () => {
  const a = analyze(
    "PIA: 2026-09-18 16:50\nMinor assessment. Distal radius fracture. I personally performed closed reduction under local anaesthetic. I applied a forearm cast.",
  );
  assert(codes(a).includes("F028"));
  assert(
    !codes(a).some((c) => ["Z201", "Z202", "Z203", "Z211", "Z213"].includes(c)),
  );
});
test("exact codes, code descriptions and everyday phrases search the full catalogue", () => {
  assert.equal(C.search("", D, F).length, 190);
  assert.equal(C.search("G521", D, F)[0].id, "G521");
  assert(C.search("distal radius", D, F).some((h) => h.codes.includes("F028")));
  assert(C.search("pronouncement", D, F).length > 0);
  assert(C.search("abcess", D, F).some((h) => h.id === "abscess"));
});
test("incompatible procedure variants cannot pass validation", () => {
  assert(
    V.validateCodes(
      [
        { code: "F028", units: 1 },
        { code: "F046", units: 1 },
      ],
      D,
      {},
    ).errors.length,
  );
});
const row = {
  encounterId: "E-1",
  reference: "Room 4",
  date: "2026-09-18",
  time: "16:50",
  payer: "ohip",
  role: "primary",
  codes: [{ code: "H101", units: 1 }],
  criticalIntervals: [],
  reviewed: true,
};
test("saved row whitelists fields and never serializes notes or evidence", () => {
  const clean = C.cleanRow(
    {
      ...row,
      note: "SECRET NOTE",
      evidence: "SECRET QUOTE",
      facts: { x: "secret" },
      codes: [{ code: "H101", units: 1, evidence: "SECRET LINE" }],
    },
    D,
  );
  assert(!JSON.stringify(clean).includes("SECRET"));
  assert(!("note" in clean));
  assert.equal(clean.status, "REVIEWED DRAFT");
});
test("backup roundtrip preserves billing data and reviewed state", () => {
  const clean = C.cleanRow(row, D);
  assert.deepEqual(
    C.importBackup(
      JSON.parse(JSON.stringify({ version: 1, ledger: [clean] })),
      D,
    ).ledger,
    [clean],
  );
});
test("malformed codes, units, dates and duplicate records are rejected", () => {
  for (const patch of [
    { codes: [{ code: "FAKE", units: 1 }] },
    { codes: [{ code: "H101", units: -1 }] },
    { date: "2026-02-30" },
    { time: "25:99" },
  ])
    assert.throws(() => C.cleanRow({ ...row, ...patch }, D));
  assert.throws(() => C.importBackup({ version: 1, ledger: [row, row] }, D));
});
test("CSV preserves quotes, line breaks and blocks spreadsheet formulas", () => {
  const csv = C.csv([
    { ...row, reference: '=HYPERLINK("bad")\nline', status: "HOLD" },
  ]);
  assert(csv.includes('"\'=HYPERLINK(""bad"")\nline"'));
  assert(C.csvCell("  =1+1").startsWith("\"'"));
});
test("restoring an existing encounter replaces it without duplicating billing", () => {
  assert.equal(
    C.mergeRows([row], [{ ...row, reference: "Revised" }]).length,
    1,
  );
  assert.equal(
    C.mergeRows([row], [{ ...row, reference: "Revised" }])[0].reference,
    "Revised",
  );
});
test("model facts need matching evidence and cannot grant payment eligibility", () => {
  const a = analyze(base);
  const f = structuredClone(a.facts);
  f.events = [
    {
      service: "abscess",
      status: "performed",
      actor: "self",
      attrs: { preamble_confirmed: true },
      evidence: "Invented evidence",
    },
  ];
  assert(
    F.validateExtraction(f, base, D).some((x) =>
      x.includes("Evidence not found"),
    ),
  );
  assert(F.validateExtraction(f, base, D).some((x) => x.includes("authorize")));
});

test("physician alone does not mean the billing clinician", () => {
  assert.equal(
    F.actor("Another physician performed the procedure.", "primary"),
    "other",
  );
  assert.equal(
    F.actor("Central line inserted by ICU physician.", "primary"),
    "other",
  );
});
test("a bundled cast needs no redundant actor question", () => {
  const a = analyze(
    base +
      "Distal radius fracture. I personally performed closed reduction under local anaesthetic. Forearm cast applied.",
  );
  assert(codes(a).includes("F028"));
  assert(!a.result.questions.some((q) => q.id === "splint_actor"));
});
