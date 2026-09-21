const fs = require("node:fs"),
  path = require("node:path");
const A = require("../engine/assist.js"),
  F = require("../engine/fastbill.js"),
  D = require("../engine/data.js");
const root = path.join(__dirname, "../qa/results");
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((a, b) => a - b);
  return x.length
    ? (x[Math.floor((x.length - 1) / 2)] + x[Math.floor(x.length / 2)]) / 2
    : null;
};
(async () => {
  const { CASES } = await import("../qa/model-cases.js");
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, "Qwen3.5-4B-q4f16_1-MLC.json")),
  );
  const baselineIds = new Set(baseline.results.map((r) => r.fixture));
  const runs = ["Qwen3.5-2B-q4f16_1-MLC", "Qwen3.5-4B-q4f16_1-MLC"].map(
    (model) => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(root, "latency-pass", model + ".json")),
      );
      const rows = raw.results.map((r) => {
        const fixture = CASES.find((f) => f.id === r.fixture),
          value = r.interpretation;
        if (!value) return { id: r.fixture, pass: false, errors: r.errors };
        const checked = A.validate(value, fixture.note, D),
          ctx = { overrides: {} };
        const { facts } = A.suggest(
          fixture.note,
          ctx,
          D,
          { date: "2026-09-21", time: "18:41" },
          value,
        );
        const bill = F.compile(facts, ctx, D, []);
        const checks = {
          structure: checked.ok,
          tier: value.care?.tier === fixture.tier,
          services: fixture.services.every((s) =>
            value.services.some(
              (e) =>
                e.service === s &&
                e.actor === "self" &&
                e.status === "performed",
            ),
          ),
          noUnsupportedProcedure: !value.services.some(
            (e) =>
              e.actor === "self" &&
              e.status === "performed" &&
              ![
                ...fixture.services,
                ...(fixture.allowedPerformed || []),
              ].includes(e.service),
          ),
          ...(fixture.expectedMinutes
            ? { minutes: bill.criticalMinutes === fixture.expectedMinutes }
            : {}),
          ...(fixture.estimated
            ? {
                estimated:
                  bill.criticalTimeBasis === "estimated" &&
                  bill.criticalMinutes > 0,
              }
            : {}),
          ...(fixture.opportunity
            ? { reassessment: bill.items.some((e) => e.code === "H104") }
            : {}),
        };
        return {
          id: r.fixture,
          pass: Object.values(checks).every(Boolean),
          checks,
          seconds: r.elapsed / 1000,
          codes: bill.line,
          criticalMinutes: bill.criticalMinutes,
          grammarSeconds: r.usage?.extra?.grammar_init_s,
          decodeTokens: r.usage?.completion_tokens,
        };
      });
      const common = rows.filter((r) => baselineIds.has(r.id));
      return {
        model,
        finished: raw.finished,
        passed: rows.filter((x) => x.pass).length,
        total: rows.length,
        medianSeconds: median(rows.map((x) => x.seconds)),
        commonMedianSeconds: median(common.map((x) => x.seconds)),
        commonCases: common.length,
        rows,
      };
    },
  );
  const report = {
    baseline: {
      model: baseline.model,
      cases: baseline.results.length,
      medianSeconds: median(baseline.results.map((r) => r.elapsed / 1000)),
    },
    runs,
  };
  fs.writeFileSync(
    path.join(root, "latency-evaluated.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const r of runs)
    console.log(
      JSON.stringify({
        model: r.model,
        passed: r.passed,
        total: r.total,
        finished: r.finished,
        medianSeconds: r.medianSeconds,
        commonMedianSeconds: r.commonMedianSeconds,
        failures: r.rows.filter((x) => !x.pass),
      }),
    );
})();
