import { LocalInterpreter } from "../vendor/semantic.js";
import { CASES } from "./model-cases.js";
const $ = (s) => document.querySelector(s);
let interpreter,
  outputs = [],
  stopped = false;
$("#stop").onclick = () => {
  stopped = true;
  interpreter?.pause();
  $("#status").textContent = "Stopped";
  $("#run").disabled = false;
};
$("#run").onclick = async () => {
  stopped = false;
  outputs = [];
  $("#results").textContent = "";
  $("#scores").replaceChildren();
  $("#run").disabled = true;
  const model = $("#model").value;
  interpreter?.pause();
  const coldStart = performance.now();
  for (const fixture of CASES) {
    if (stopped) break;
    const started = performance.now();
    const outcome = await new Promise((resolve) => {
      let timeout;
      const done = (x) => {
        clearTimeout(timeout);
        resolve(x);
      };
      if (!interpreter || outputs.length === 0)
        interpreter = new LocalInterpreter({
          model,
          onStatus: (s) => {
            $("#status").textContent = fixture.id + ": " + s.message;
          },
          onResult: () => {},
          onError: () => {},
        });
      interpreter.handlers.onStatus = (s) => {
        $("#status").textContent = fixture.id + ": " + s.message;
      };
      interpreter.handlers.onResult = done;
      interpreter.handlers.onError = done;
      timeout = setTimeout(
        () => done({ message: "Evaluation deadline exceeded" }),
        900000,
      );
      interpreter.analyze(
        fixture.note,
        FASTBILL_DATA.services.map((x) => ({ id: x.id, label: x.label })),
        FolioAssist.serviceSeeds(
          fixture.note,
          { overrides: {} },
          FASTBILL_DATA,
        ),
      );
    });
    const value = outcome.interpretation;
    const valid = value
      ? FolioAssist.validate(value, fixture.note, FASTBILL_DATA)
      : { ok: false, errors: [outcome.message] };
    const facts =
      value && valid.ok
        ? FolioAssist.suggest(
            fixture.note,
            { overrides: {} },
            FASTBILL_DATA,
            { date: "2026-09-21", time: "14:00" },
            value,
          ).facts
        : null;
    const checks = {
      valid: valid.ok,
      tier: value?.care?.tier === fixture.tier,
      noExtraProcedure: !(value?.services || []).some(
        (e) =>
          e.actor === "self" &&
          e.status === "performed" &&
          ![...fixture.services, ...(fixture.allowedPerformed || [])].includes(
            e.service,
          ),
      ),
      ...(fixture.expectedMinutes
        ? { minutes: facts?.carePlan?.minutes === fixture.expectedMinutes }
        : {}),
      services: fixture.services.every((s) =>
        value?.services.some(
          (e) =>
            e.service === s && e.actor === "self" && e.status === "performed",
        ),
      ),
      actor: !(value?.services || []).some(
        (e) =>
          e.actor === "self" &&
          e.status === "performed" &&
          ((fixture.forbiddenPerformed || []).includes(e.service) ||
            (fixture.excludes || []).includes(e.service)),
      ),
      ...(fixture.estimated
        ? {
            estimate:
              !!facts?.carePlan?.minutes &&
              facts.carePlan.basis === "estimated",
          }
        : {}),
      ...(fixture.opportunity
        ? {
            opportunity:
              value?.opportunities.some(
                (o) => o.pathway === fixture.opportunity,
              ) || !!value?.reassessments?.length,
          }
        : {}),
    };
    const row = {
      fixture: fixture.id,
      model,
      checks,
      errors: valid.errors,
      elapsed: outcome.elapsed,
      wallMs: performance.now() - started,
      interpretation: value,
      usage: outcome.usage,
    };
    outputs.push(row);
    const li = document.createElement("li");
    li.textContent =
      fixture.id +
      " · " +
      Object.values(checks).filter(Boolean).length +
      "/" +
      Object.keys(checks).length +
      " · " +
      ((outcome.elapsed || 0) / 1000).toFixed(1) +
      " s";
    $("#scores").append(li);
    $("#results").textContent = JSON.stringify(
      { model, results: outputs },
      null,
      2,
    );
    await fetch("/__qa_result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        finished: outputs.length === CASES.length,
        coldWallMs: performance.now() - coldStart,
        results: outputs,
      }),
    });
    if (!value) break;
  }
  interpreter?.pause();
  interpreter = null;
  $("#run").disabled = false;
  $("#status").textContent = "Evaluation complete";
};
