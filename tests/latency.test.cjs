const test = require("node:test"),
  assert = require("node:assert/strict");
const A = require("../engine/assist.js"),
  F = require("../engine/fastbill.js"),
  D = require("../engine/data.js"),
  Care = require("../engine/care.js");
const note =
  "29 year old female, nausea vomiting headache. i gave her fluids because tachy. critical G code 25 minute r/a x2.";
const now = { date: "2026-09-21", time: "18:41" };
const run = (text, semantic = null, ctx = { overrides: {} }) => {
  const { facts } = A.suggest(text, ctx, D, now, semantic);
  return { facts, bill: F.compile(facts, ctx, D, []) };
};
test("the reported G-code shorthand builds 25 minutes before any model result", () => {
  const { facts, bill } = run(note);
  assert.equal(bill.criticalMinutes, 25);
  assert.equal(bill.criticalTimeBasis, "estimated");
  assert.deepEqual(
    bill.items.map((x) => x.code),
    ["G395", "G391", "H114"],
  );
  assert.equal(bill.questions.length, 0);
  assert.equal(facts.carePlan.episodes[0].start, "18:41");
  assert.equal(facts.carePlan.episodes[0].end, "19:06");
});
test("a model none result cannot erase explicit physician G-code care or multiply reassessments into duration", () => {
  const semantic = {
    assessment: { level: "minor", reason: "Focused assessment.", quote: note },
    care: { tier: "none", reason: "No care.", quote: note, episodes: [] },
    services: [],
    work: [],
    opportunities: [],
  };
  const { bill } = run(note, semantic);
  assert.equal(bill.criticalMinutes, 25);
  assert(bill.items.some((x) => x.code === "G395"));
});
test("G-code shorthand preserves recorded clocks instead of proposing arbitrary bounds", () => {
  const { bill } = run(
    "Fluid resuscitation. critical G code 14:00 to 14:25, r/a x2.",
  );
  assert.equal(bill.criticalMinutes, 25);
  assert.equal(bill.criticalTimeBasis, "documented");
  assert(!bill.items.some((x) => x.code === "H114"));
});
test("fluid resuscitation and reassessments get a proposed timeline while routine hydration does not", () => {
  const positive = run(
    "Vomiting, tachycardic. Gave fluid boluses and reassessed perfusion twice.",
  );
  assert.equal(positive.bill.criticalMinutes, 15);
  assert.equal(positive.bill.criticalTimeBasis, "estimated");
  for (const text of [
    "Chest pain, 25 minutes.",
    "Mild tachycardia, drank water. No further care.",
    "Fluids for headache. No critical care.",
    "No G code. Stable after fluids.",
  ])
    assert.equal(run(text).bill.critical, false, text);
});
test("manual assessment alternative and confirmed interval clocks remain authoritative", () => {
  assert.equal(
    run(note, null, { overrides: { criticalTier: "none" } }).bill.critical,
    false,
  );
  const ctx = {
    overrides: {},
    time: "11:00",
    careConfirmed: true,
    careEpisodes: [
      { start: "18:41", end: "19:06", kind: "care", label: "Care" },
    ],
  };
  const { facts, bill } = run(note, null, ctx);
  assert.equal(facts.carePlan.episodes[0].start, "18:41");
  assert.equal(bill.criticalTimeBasis, "confirmed");
});
test("compact model grammar is reusable and expands grounded actor provenance", async () => {
  const { fastSchema, expandPlan } = await import("../src/semantic-fast.js");
  const passages = {
    S0: "ICU placed a central line. Reassessed at 14:30.",
    S1: "ICU placed a central line.",
  };
  assert.deepEqual(
    fastSchema(D.services, passages),
    fastSchema(D.services, { S0: "Different encounter at 19:05." }),
  );

  const result = expandPlan(
    {
      a: "multisystem",
      c: "none",
      e: [],
      s: [
        {
          id: "central_line",
          by: "other",
          status: "performed",
          q: "S1",
          site: "",
          cm: 0,
          anaesthesia: "unknown",
        },
      ],
      r: [],
      w: [],
    },
    passages,
    D.services,
  );
  assert.equal(result.services[0].actor, "other");
  assert.equal(A.validate(result, passages.S0, D).ok, true);
});

test("recorded range identifiers preserve outer care and excluded interruptions", async () => {
  const { expandPlan, fastNote } = await import("../src/semantic-fast.js");
  const text =
    "I managed shock 14:00 to 14:40, except 14:12 to 14:22 with another patient. Returned 15:00 to 15:15 for further pressor titration.";
  const p = { S0: text, S1: text };
  assert.match(fastNote(p), /\[R2 14:12 to 14:22\]/);
  const m = expandPlan(
    {
      a: "multisystem",
      c: "life",
      e: [
        { q: "S1", range: "R1", m: 0, x: false },
        { q: "S1", range: "R2", m: 0, x: true },
        { q: "S1", range: "R3", m: 0, x: false },
      ],
      s: [],
      r: [],
      w: [],
    },
    p,
    D.services,
  );
  assert.equal(run(text, m).bill.criticalMinutes, 45);
});
test("a stated active-care duration replaces model-estimated duplicates for the same untimed care", () => {
  const text =
    "Hypotensive, started levophed. I spent 20 minutes actively managing his shock; no start clock recorded.";
  const care = {
    tier: "life",
    reason: "Shock care",
    quote: text,
    episodes: [15, 15, 20].map((m) => ({
      label: "Shock management",
      quote: text,
      start: "",
      end: "",
      minutes: m,
      kind: "care",
      timing: "estimated",
    })),
  };
  const m = {
    assessment: { level: "multisystem", reason: "Shock care", quote: text },
    care,
    work: [],
    services: [],
    opportunities: [],
  };
  assert.equal(run(text, m).bill.criticalMinutes, 20);
  assert.equal(
    run("Headache; no tachycardia. Gave fluids, reassessed twice.").bill
      .critical,
    false,
  );
});

test("recognized care with omitted model minutes gets a visibly labelled editable starting block", () => {
  const text =
    "Hypotensive after fluids. Started a pressor, repeatedly reassessed perfusion.";
  const model = {
    assessment: { level: "multisystem", reason: "Resuscitation", quote: text },
    care: {
      tier: "life",
      reason: "Pressor resuscitation",
      quote: text,
      episodes: [
        {
          label: "Pressor care",
          quote: text,
          start: "",
          end: "",
          minutes: 0,
          kind: "care",
          timing: "estimated",
        },
      ],
    },
    services: [],
    work: [],
    opportunities: [],
  };
  const { facts, bill } = run(text, model);
  assert.equal(bill.criticalMinutes, 15);
  assert.equal(bill.criticalTimeBasis, "estimated");
  assert.match(facts.carePlan.episodes[0].label, /starting estimate/);
  assert(!bill.questions.some((q) => q.field === "intervals"));
});

test("separate stated active-care durations retain their individual episodes", () => {
  const text = "I spent 20 minutes actively managing shock. Later spent 25 minutes actively titrating a pressor.";
  const model = {
    assessment: { level: "multisystem", reason: "Resuscitation", quote: text },
    care: {
      tier: "life", reason: "Shock care", quote: text,
      episodes: [20, 25].map((minutes) => ({ label: "Active care", quote: text,
        start: "", end: "", minutes, kind: "care", timing: "estimated" })),
    },
    services: [], work: [], opportunities: [],
  };
  assert.equal(run(text, model).bill.criticalMinutes, 45);
});
