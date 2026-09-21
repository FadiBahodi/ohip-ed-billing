const fs = require("node:fs"),
  path = require("node:path");
const A = require("../engine/assist.js"),
  F = require("../engine/fastbill.js"),
  D = require("../engine/data.js");
(async () => {
  const { CASES } = await import("../qa/model-cases.js");
  const files = [
    "initial/Qwen3-4B-q4f16_1-MLC.json",
    "initial/Qwen3.5-2B-q4f16_1-MLC.json",
    "initial/Qwen3.5-4B-q4f16_1-MLC.json",
    "reconstruction-pass/Qwen3.5-2B-q4f16_1-MLC.json",
    "reconstruction-pass/Qwen3.5-4B-q4f16_1-MLC.json",
    "Qwen3.5-4B-q4f16_1-MLC.json",
  ];
  const runs = files.map((file) => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../qa/results", file)),
    );
    const cases = raw.results.map((row) => {
      const fixture = CASES.find((c) => c.id === row.fixture),
        model = row.interpretation;
      if (!model) return { id: row.fixture, passed: false, error: row.errors };
      const checked = A.validate(model, fixture.note, D),
        ctx = { overrides: {}, note: fixture.note };
      const { facts } = A.suggest(
          fixture.note,
          ctx,
          D,
          { date: "2026-09-21", time: "14:00" },
          model,
        ),
        bill = F.compile(facts, ctx, D, []);
      const checks = {
        structure: checked.ok,
        tier: model.care?.tier === fixture.tier,
        requiredServices: fixture.services.every((id) =>
          model.services.some(
            (s) =>
              s.service === id &&
              s.actor === "self" &&
              s.status === "performed",
          ),
        ),
        noUnsupportedProcedure: !model.services.some(
          (s) =>
            s.actor === "self" &&
            s.status === "performed" &&
            ![
              ...fixture.services,
              ...(fixture.allowedPerformed || []),
            ].includes(s.service),
        ),
        ...(fixture.expectedMinutes
          ? { minutes: bill.criticalMinutes === fixture.expectedMinutes }
          : {}),
        ...(fixture.estimated
          ? {
              proposedTime:
                bill.criticalMinutes > 0 &&
                bill.criticalTimeBasis === "estimated",
            }
          : {}),
        ...(fixture.opportunity
          ? { reassessment: bill.items.some((i) => i.code === "H104") }
          : {}),
      };
      return {
        id: row.fixture,
        passed: Object.values(checks).every(Boolean),
        checks,
        seconds: Math.round(row.elapsed / 100) / 10,
        codes: bill.line,
        criticalMinutes: bill.criticalMinutes,
        timeBasis: bill.criticalTimeBasis,
        openQuestions: bill.questions.map((q) => q.field),
      };
    });
    const times = cases
      .map((c) => c.seconds)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return {
      file,
      model: raw.model,
      passed: cases.filter((c) => c.passed).length,
      total: cases.length,
      minSeconds: times[0],
      maxSeconds: times.at(-1),
      medianSeconds: times[Math.floor(times.length / 2)],
      cases,
    };
  });
  fs.writeFileSync(
    path.join(__dirname, "../qa/results/evaluated.json"),
    JSON.stringify(runs, null, 2) + "\n",
  );
  for (const r of runs)
    console.log(
      r.file +
        ": " +
        r.passed +
        "/" +
        r.total +
        ", median " +
        r.medianSeconds +
        " s",
    );
})();
