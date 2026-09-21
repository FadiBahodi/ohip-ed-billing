# Folio 1.3 latency and G-code regression

The selected model remains Qwen3.5 4B (q4f16, WebLLM 0.2.85). The speed improvement comes from a compact work plan, reusable output grammar, range identifiers for recorded clock intervals, and conditional procedure checks. Repeat assessments are extracted in the main pass. The longer review remains available through “Explore additional capture”.

## Actual browser measurements

| Pipeline | Scoped cases passing | Median inference |
|---|---:|---:|
| Folio 1.2, previous 4B pipeline | 12 / 12 | 14.0 s |
| Compact 2B experiment | 11 / 16 | 5.8 s |
| Final compact 4B + current calculator | 16 / 16 | 8.3 s |

On the same twelve encounters as the baseline, median inference fell from 13.983 to 8.270 seconds, approximately 41%. The sixteen-case range was 5.5–13.0 seconds, excluding model initialization. This uses the conventional median (average of the middle two values); the earlier evaluation document used the upper middle value, reporting 14.4 seconds for the baseline. Raw files and `scripts/evaluate_latency.cjs` make this reproducible.

The 2B experiment was rejected: it misclassified shock/respiratory cases and a repeat assessment. Its speed run predates the final range-ID format, so it is not an otherwise identical final-pipeline comparison. The 4B optimization also required corrections during development; raw partial and calibration runs are retained. In the final run, the model identified shock but emitted zero minutes; the calculator offered a labelled 15-minute starting estimate. “16/16” covers the connected interpretation/calculation checks, not perfect raw model output.

The reported tachycardia/fluid note took 9.7 seconds in the benchmark's first case. In the connected app with startup preparation, actual runs took 9.2 and 8.9 seconds. Its 25-minute G395 + G391 + H114 draft was already visible before inference began. The 100 ms edit debounce drives that initial draft; it does not wait for the model.

With a per-note grammar, compilation took around 3.1–3.4 seconds on several encounters. The final static grammar's median initialization was under 1 ms after its first compilation. Evidence references and clock bounds are still checked against the note. Model preparation and a one-token synthetic grammar warmup begin when Folio opens. Model files remain cached per browser/origin; no clinical note is used for warmup or uploaded.

## Connected checks

- The exact reported shorthand yields 25 minutes, not 50 from “r/a x2”; it stays on G395/G391 after interpretation.
- Start, End and Minutes appear directly in the care card. Editing Minutes from 25 to 40 adds a second G391 unit. Moving Start preserves duration. Changing End back to a 25-minute block recalculates it.
- Confirming 20:00–20:25 while inference is pending preserves those clocks after the model finishes. Clipboard output is G395 + G391 + H114. Saving the local QA draft and reloading succeeds.
- A 320 CSS-pixel viewport has no horizontal overflow; both clock values remain readable, with the Minutes control on the next row.
- Fifty-five software tests pass, including explicit G-code duration, negation, active-duration precedence, source range IDs, stale model responses and initialization without clinical text.

These are synthetic engineering acceptance cases, iterated during development, not independent clinical validation or universal hardware benchmarks. A starting time block is explicitly a proposal; clinical eligibility and current Schedule coverage are separate from parsing a clinician's billing intent. Full rates, cross-date allocation and catalogue limitations remain documented in `QA.md`.
