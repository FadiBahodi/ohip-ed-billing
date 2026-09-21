const test = require("node:test"),
  assert = require("node:assert/strict");
const Care = require("../engine/care.js"),
  A = require("../engine/assist.js"),
  F = require("../engine/fastbill.js"),
  D = require("../engine/data.js"),
  C = require("../core.js");
const now = { date: "2026-09-21", time: "14:00" };
function interpretation(note, episodes, tier = "life") {
  return {
    assessment: { level: "multisystem", reason: "Assessment", quote: note },
    work: [],
    services: [],
    opportunities: [],
    care: {
      tier,
      reason: "Shock with active pressor titration.",
      quote: note,
      episodes,
    },
  };
}
function run(note, model, ctx = { overrides: {} }) {
  const x = A.suggest(note, ctx, D, now, model);
  return { ...x, result: F.compile(x.facts, ctx, D, []) };
}
const ep = (
  quote,
  start,
  end,
  kind = "care",
  timing = "documented",
  minutes = 0,
) => ({
  label: kind === "care" ? "Pressor titration" : "Another patient",
  quote,
  start,
  end,
  kind,
  timing,
  minutes,
});
test("care reconstruction subtracts interruptions, merges overlap and aggregates once", () => {
  const note =
    "Shock, active norepi 14:00 to 14:40. Another patient 14:12 to 14:22. Returned 15:00 to 15:15 for hypotension and pressors.";
  const model = interpretation(note, [
    ep(note, "14:00", "14:40"),
    ep(note, "14:00", "14:10"),
    ep(note, "14:12", "14:22", "excluded"),
    ep(note, "15:00", "15:15"),
  ]);
  const x = run(note, model);
  assert.equal(x.result.criticalMinutes, 45);
  assert.equal(x.facts.carePlan.excludedMinutes, 10);
  assert.deepEqual(
    x.result.items
      .filter((i) => /^G52/.test(i.code))
      .map((i) => [i.code, i.units]),
    [
      ["G521", 1],
      ["G523", 1],
      ["G522", 1],
    ],
  );
  assert(
    !x.result.questions.some(
      (q) => q.field === "intervals" || q.field === "exclusive",
    ),
  );
  assert.equal(x.result.criticalTimeBasis, "documented");
  assert.equal(x.result.criticalProposed, true);
});
test("model estimates build a bill immediately and remain proposed through backup and CSV", () => {
  const note =
    "Shock despite fluids. Norepi started and titrated twice, repeat perfusion checks.";
  const x = run(
    note,
    interpretation(note, [ep(note, "", "", "care", "estimated", 24)]),
  );
  assert.equal(x.result.criticalMinutes, 24);
  assert.equal(x.result.criticalTimeBasis, "estimated");
  assert(x.result.items.some((i) => i.code === "G523"));
  const row = C.cleanRow(
    {
      encounterId: "a",
      reference: "Synthetic",
      codes: x.result.items,
      date: now.date,
      time: now.time,
      criticalMinutes: 24,
      criticalIntervals: x.result.criticalIntervals,
      criticalTimeBasis: x.result.criticalTimeBasis,
      criticalProposed: true,
      reviewed: true,
    },
    D,
  );
  assert.equal(row.status, "PROPOSED TIMING");
  assert.equal(row.reviewed, false);
  assert.match(C.csv([row]), /estimated/);
  assert.match(Care.documentation(x.facts), /estimated/);
  const confirmed = run(
    note,
    interpretation(note, [ep(note, "", "", "care", "estimated", 24)]),
    { overrides: {}, careConfirmed: true },
  );
  assert.equal(confirmed.result.criticalTimeBasis, "confirmed");
  assert.equal(confirmed.result.criticalProposed, false);
});
test("unsupported model clock values cannot become recorded timing", () => {
  const note = "Shock managed with pressors.";
  const x = run(
    note,
    interpretation(note, [
      ep(note, "09:00", "09:30", "care", "documented", 30),
    ]),
  );
  assert.equal(x.facts.carePlan.basis, "estimated");
  assert.equal(x.facts.carePlan.episodes[0].start, "14:00");
});
test("explicit critical-care intervals work without the old exclusive checkbox", () => {
  const note =
    "Septic shock. Started norepinephrine. Critical care 14:00–14:16; 14:40–14:50.";
  const x = run(note, null);
  assert.equal(x.result.criticalMinutes, 26);
  assert(x.result.items.some((i) => i.code === "G521"));
  assert.equal(x.result.questions.length, 0);
});
test("physician assessment alternative wins over the model", () => {
  const note = "Shock, norepi titrated.";
  const x = run(
    note,
    interpretation(note, [ep(note, "", "", "care", "estimated", 24)]),
    { overrides: { criticalTier: "none" } },
  );
  assert.equal(x.facts.carePlan, null);
  assert(!x.result.critical);
  assert(x.result.items.some((i) => i.code === "H103"));
});
test("stable observation and elapsed ED duration alone create no care intervals", () => {
  const note = "Stable chest pain, waited 4 hours for labs.";
  const x = run(note, interpretation(note, [], "none"));
  assert.equal(x.facts.carePlan, null);
  assert(!x.result.critical);
});
test("recorded critical-care times outrank now for the service premium", () => {
  const ctx = { overrides: {} };
  const note =
    "Septic shock. Started norepinephrine. Critical care 14:00–14:20.";
  const x = A.suggest(note, ctx, D, { date: "2026-09-21", time: "18:00" });
  const bill = F.compile(x.facts, ctx, D, []);
  assert.equal(x.facts.time, "14:00");
  assert(!bill.items.some((i) => i.code === "H114"));
});
test("semantic reassessment adds the separate timed assessment without a questionnaire", () => {
  const note =
    "PIA 09:00 flank pain. At 11:40 I reassessed persistent pain and vomiting; repeat exam, CT and more analgesia.";
  const model = interpretation(note, [], "none");
  model.reassessments = [
    {
      time: "11:40",
      quote: note,
      reason:
        "Persistent symptoms with repeat examination, CT and further treatment.",
      newCare: true,
      dispositionOnly: false,
    },
  ];
  const x = run(note, model);
  assert(x.result.items.some((i) => i.code === "H104"));
});
test("reassessment spacing is measured from the previous assessment, not always the first", () => {
  const note =
    "PIA 09:00 pain. Reassessed at 11:10 and 12:00 for pain and additional treatment.";
  const model = interpretation(note, [], "none");
  model.reassessments = ["11:10", "12:00"].map((time) => ({
    time,
    quote: note,
    reason: "Further treatment.",
    newCare: true,
    dispositionOnly: false,
  }));
  const x = run(note, model);
  assert.equal(x.result.items.find((i) => i.code === "H104")?.units, 1);
});
test("chunking preserves every source span and merge retains both timed episodes", async () => {
  const { chunkNote, mergeInterpretations } = await import(
    "../src/semantic-response.js"
  );
  const note =
    "A detailed sentence describing work.\n".repeat(180) + "Final new finding.";
  const chunks = chunkNote(note);
  assert(chunks.length > 3);
  assert(chunks.every((x) => x.length <= 1600));
  assert.equal(chunks.join("").replace(/\s/g, ""), note.replace(/\s/g, ""));
  const first = interpretation("First", [ep("First", "14:00", "14:15")]),
    second = interpretation("Second", [ep("Second", "15:00", "15:15")]);
  const m = mergeInterpretations([first, second]);
  assert.equal(m.care.episodes.length, 2);
});
test("model bounds resolve against recorded ranges even when work evidence is in another passage", () => {
  const note =
    "PIA 14:00. Septic shock; resuscitation 14:00 to 14:40, except another patient 14:12 to 14:22. Returned 15:00 to 15:15 for hypotension and norepi.";
  const model = interpretation(note, [
    ep("PIA 14:00.", "14:00", "14:40"),
    ep("PIA 14:00.", "14:12", "14:22", "excluded"),
    ep("PIA 14:00.", "15:00", "15:15"),
  ]);
  const x = run(note, model);
  assert.equal(x.facts.carePlan.minutes, 45);
  assert.deepEqual(
    x.facts.carePlan.intervals.map((i) => [i.start, i.end]),
    [
      ["14:00", "14:12"],
      ["14:22", "14:40"],
      ["15:00", "15:15"],
    ],
  );
  assert.equal(x.facts.carePlan.basis, "documented");
});
test("source bundle rule bindings resolve to Lamina IDs and immutable hashes", () => {
  const sources = require("../engine/source-bundle.js");
  assert.equal(sources.sources.length, 2);
  for (const [rule, keys] of Object.entries(sources.ruleEvidence)) {
    assert(D.rules.some((r) => r.id === rule));
    for (const key of keys) {
      const x = sources.sources.find((s) => s.key === key);
      assert.match(x.sourceId, /^src_[0-9a-f]{20}$/);
      assert.match(x.unitId, /^unit_[0-9a-f]{20}$/);
      assert.match(x.htmlSha256, /^[0-9a-f]{64}$/);
      assert(x.quote.length > 10);
    }
  }
});
test("a facial site from semantic interpretation uses the facial wound code", () => {
  const note = "I sewed the 2 cm chin wound with nylon under local lidocaine.";
  const model = interpretation(note, [], "none");
  model.assessment.level = "minor";
  model.services = [
    {
      service: "laceration",
      actor: "self",
      status: "performed",
      quote: note,
      site: "chin",
      anaesthesia: "local",
      purpose: "repair",
      length_cm: 2,
    },
  ];
  const x = run(note, model);
  assert(x.result.items.some((i) => i.code === "Z154"));
  assert(!x.result.items.some((i) => i.code === "Z176"));
});
test("bundled vascular access never creates an irrelevant operator question during critical care", () => {
  const note =
    "Septic shock. Started norepinephrine. Critical care 14:00–14:20. ICU inserted the central line.";
  const x = run(note, null);
  assert(x.result.critical);
  assert(
    !x.result.questions.some((q) => q.field === "events.central_line.actor"),
  );
});
test("sedation by this physician uses the other operator procedure to build its C-suffix worksheet", () => {
  const note =
    "I was the sedation physician only. I gave propofol for sedation 14:00–14:20 while cardiology performed cardioversion.";
  const model = interpretation(note, [], "none");
  model.services = [
    {
      service: "cardioversion",
      actor: "other",
      status: "performed",
      quote: note,
      site: "unknown",
      anaesthesia: "sedation",
      purpose: "cardioversion",
      length_cm: 0,
    },
  ];
  const ctx = { overrides: {}, note };
  const x = run(note, model, ctx);
  assert(x.result.items.some((i) => i.code === "Z437C"));
  assert(!x.result.items.some((i) => i.code === "Z437"));
});
