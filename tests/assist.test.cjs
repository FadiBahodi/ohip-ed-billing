const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../engine/assist.js");
const F = require("../engine/fastbill.js");
const D = require("../engine/data.js");
const now = { date: "2026-09-21", time: "17:30" };
function suggest(note, overrides = {}, model = null, clock = now) {
  const ctx = { encounterId: "live-test", overrides: {}, ...overrides };
  const a = A.suggest(note, ctx, D, clock, model);
  return { ...a, result: F.compile(a.facts, ctx, D, []) };
}
const codes = (a) => a.result.items.map((x) => x.code);
const interpretation = (patch) => ({
  assessment: {
    level: "multisystem",
    reason: "Substantive chest-pain evaluation.",
    quote: "chest pain",
  },
  work: [],
  services: [],
  opportunities: [],
  ...patch,
});
test("semantic critical-care opportunity builds a distinct pathway only with supplied care intervals", () => {
  const note =
    "Hypotensive after fluids. Started norepi and titrated twice. 45 min in ED.";
  const model = interpretation({
    assessment: {
      level: "multisystem",
      reason: "Shock assessment.",
      quote: note,
    },
    opportunities: [
      {
        title: "Critical-care work",
        detail: "Pressor titration suggests resuscitative work.",
        quote: "Started norepi and titrated twice.",
        pathway: "critical_life",
      },
    ],
  });
  assert(!codes(suggest(note, {}, model)).includes("G521"));
  const a = suggest(
    note,
    {
      overrides: {
        criticalTier: "life",
        intervals: "17:00–17:20",
        exclusive: true,
      },
    },
    model,
  );
  assert(codes(a).includes("G521"));
  assert(codes(a).includes("G523"));
  assert.equal(a.result.criticalMinutes, 20);
  assert(!codes(a).includes("H133"));
});
test("passage IDs resolve to original evidence and cannot introduce fabricated text", async () => {
  const { evidencePassages, resolveEvidence } = await import(
    "../src/semantic-response.js"
  );
  const passages = evidencePassages("3.5 cm wound. Closed with nylon.");
  assert.equal(passages.S1, "3.5 cm wound.");
  const result = {
    assessment: { quote: "S0" },
    work: [{ quote: "S2" }],
    services: [],
    opportunities: [],
  };
  assert.equal(
    resolveEvidence(result, passages).work[0].quote,
    "Closed with nylon.",
  );
  assert.throws(() =>
    resolveEvidence({ ...result, assessment: { quote: "S9" } }, passages),
  );
});
test("the reported chest-pain note immediately suggests H133 at Monday 17:30", () => {
  const a = suggest("27 year old female, chest pain, 25 minutes.");
  assert.deepEqual(codes(a), ["H133"]);
  assert.deepEqual(a.result.questions, []);
  assert.deepEqual(
    a.assumptions.map((x) => x.source),
    ["today", "now"],
  );
  assert.equal(a.facts.critical.tier, "none");
  assert.equal(a.facts.assessment.origin, "practice-default");
});
test("a model cannot silently narrow a sparse chest-pain note below the working ED assessment", () => {
  const note = "27 year old female, chest pain, 25 minutes.";
  for (const level of ["minor", "comprehensive"]) {
    const model = interpretation({
      assessment: { level, reason: "Suggested assessment.", quote: note },
    });
    const a = suggest(note, {}, model);
    assert.deepEqual(codes(a), ["H133"]);
    assert.equal(a.facts.assessment.origin, "practice-default");
  }
});
test("current-clock defaults follow daytime, overnight and weekend bands", () => {
  for (const [date, time, code] of [
    ["2026-09-21", "15:30", "H103"],
    ["2026-09-21", "02:00", "H123"],
    ["2026-09-20", "17:30", "H153"],
  ])
    assert.deepEqual(codes(suggest("Chest pain.", {}, null, { date, time })), [
      code,
    ]);
  assert.deepEqual(A.clock(new Date("2026-09-22T01:12:00Z")), {
    date: "2026-09-21",
    time: "21:12",
    zone: "America/Toronto",
  });
});
test("a note date and assessment time outrank today and now", () => {
  const a = suggest("PIA: 2026-09-18 16:50. Chest pain. Note signed 19:00.");
  assert.equal(a.facts.date, "2026-09-18");
  assert.equal(a.facts.time, "16:50");
  assert.deepEqual(codes(a), ["H103"]);
  assert.deepEqual(a.assumptions, []);
  assert.equal(suggest("Yesterday chest pain.").facts.date, "2026-09-20");
});
test("clinician correction wins over both note and model suggestions", () => {
  const a = suggest(
    "PIA: 2026-09-18 16:50. chest pain",
    {
      date: "2026-09-21",
      dateConfirmed: true,
      time: "17:30",
      overrides: { level: "comprehensive" },
    },
    interpretation(),
  );
  assert.deepEqual(codes(a), ["H132"]);
  assert.equal(a.facts.assessment.confirmed, true);
});
test("semantic service interpretation reaches the deterministic billing compiler", () => {
  const note = "I closed the 3 cm forearm cut with stitches under local.";
  const model = interpretation({
    assessment: {
      level: "minor",
      reason: "Focused injury assessment and repair.",
      quote: note,
    },
    work: [{ label: "Wound closure", quote: note, certainty: "documented" }],
    services: [
      {
        service: "laceration",
        actor: "self",
        status: "performed",
        quote: note,
        site: "forearm",
        anaesthesia: "local",
        purpose: "repair",
        length_cm: 3,
      },
    ],
  });
  assert(!codes(suggest(note)).includes("Z176"));
  const a = suggest(note, {}, model);
  assert(codes(a).includes("Z176"));
  assert(codes(a).includes("H131"));
  assert.equal(a.facts.events[0].origin, "model");
});
test("semantic interpretation preserves other-provider and refused work", () => {
  const note = "ICU put in the central line. Patient declined drainage.";
  const model = interpretation({
    assessment: { level: "multisystem", reason: "ED assessment.", quote: note },
    services: [
      {
        service: "central_line",
        actor: "other",
        status: "performed",
        quote: "ICU put in the central line.",
        length_cm: 0,
      },
      {
        service: "abscess",
        actor: "self",
        status: "refused",
        quote: "Patient declined drainage.",
        length_cm: 0,
      },
    ],
  });
  // Use the catalogue identifier rather than a model-invented fee code.
  model.services[0].service = D.services.find((x) =>
    /central.*(?:venous|line)|central/i.test(x.label),
  ).id;
  const a = suggest(note, {}, model);
  assert(a.interpretation);
  assert(!codes(a).includes("G269"));
  assert(!codes(a).includes("Z101"));
});
test("invented evidence and measurements are rejected without suppressing the fast draft", () => {
  const model = interpretation({
    work: [
      {
        label: "Intubated",
        quote: "I intubated the patient",
        certainty: "documented",
      },
    ],
  });
  const a = suggest("chest pain", {}, model);
  assert.equal(a.interpretation, null);
  assert.deepEqual(codes(a), ["H133"]);
  model.work = [];
  model.services = [
    {
      service: "laceration",
      actor: "self",
      status: "performed",
      quote: "chest pain",
      length_cm: 5,
    },
  ];
  assert.equal(A.validate(model, "chest pain", D).ok, false);
});
test("WebLLM empty thinking prefill is parsed but substantive reasoning is not disguised as JSON", async () => {
  const { parseInterpretation } = await import("../src/semantic-response.js");
  assert.deepEqual(parseInterpretation('<think>\n\n</think>\n\n{"work":[]}'), {
    work: [],
  });
  assert.throws(() =>
    parseInterpretation('<think>invented output</think>{"work":[]}'),
  );
});
