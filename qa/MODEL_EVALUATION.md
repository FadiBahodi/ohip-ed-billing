# Browser model evaluation — 2026-09-21

Folio 1.2 selects **Qwen3.5 4B, q4f16**, through WebLLM 0.2.85. This is a task-specific engineering choice from three tested browser models, not a claim that it is universally the best model for billing.

All captured outputs came from actual WebGPU inference in the Codex Chromium browser. Patient notes were not used. The fixtures, raw outputs and a deterministic rescorer are in this directory and `scripts/evaluate_models.cjs`.

## Comparison

The initial identical prompt/contract exposed weaknesses in every model. The first rubric checked syntax and tier too loosely; `results/evaluated.json` rescored the raw outputs against the resulting care timeline, procedure attribution and bill. Use that rescore rather than the older per-row counters.

| Run | Cases meeting scoped checks | Median inference time |
|---|---:|---:|
| Initial Qwen3 4B | 3 / 8 | 22.1 s |
| Initial Qwen3.5 2B | 5 / 8 | 5.7 s |
| Initial Qwen3.5 4B | 3 / 8 | 11.6 s |
| Reconstruction examples, Qwen3.5 2B | 4 / 8 | 11.9 s |
| Reconstruction examples, Qwen3.5 4B | 6 / 8 | 13.7 s |
| Final Qwen3.5 4B pipeline | 12 / 12 | 14.4 s |

The final pipeline uses the reconstruction prompt plus short independent procedure-attribution and reassessment passes. Its 12-case inference range was **9.3–25.3 seconds**, excluding initial model loading. The ordinary working bill appears while the model runs.

The 2B model was faster, but after adding care reconstruction examples it inferred resuscitation from the sparse chest-pain note and attributed another operator's line to the billing physician. Qwen3 4B missed critical-care tiers and added unsupported procedures. Qwen3.5 4B also made errors in its initial single-pass output; targeted work checks and deterministic calculation improved this particular pipeline. The final pipeline was not compared against every available model or quantization.

The WebLLM registry estimates 3,867.82 MB of GPU memory for the selected configuration. This is a registry estimate, not a measurement of total browser/process peak memory. Original model: https://huggingface.co/Qwen/Qwen3.5-4B. Browser conversion: https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f16_1-MLC.

## What the cases check

- Sparse chest pain remains an ordinary assessment; time spent in the ED does not create critical care.
- Colloquial wound closure maps to repair; facial anatomy is normalized by the rule engine.
- Pressor-treated shock can generate an editable proposed active-care duration without requiring the phrase “critical care”.
- Intermittent resuscitation aggregates correctly: 40 minutes minus a 10-minute interruption, plus 15 minutes later, gives 45 minutes.
- Recorded respiratory-care blocks aggregate to 33 minutes.
- Refused procedures and other-operator work do not become the physician's procedure claims.
- Repeat examination with new investigation/treatment can reach the separate reassessment code.
- Explicit 20 minutes of active shock management is retained, while absent clock bounds remain proposed.

Eight development cases informed iteration; four additional cases were not used as prompt examples. Twelve synthetic cases are a small engineering acceptance set. They do not establish clinical accuracy, calibrated time estimates, complete capture, or complete OHIP eligibility. The sedation-role case checks attribution; the underlying shoulder C-suffix listing is still absent from the focused catalogue and is surfaced as a source/coverage question rather than treated as a verified complete bill.

Long-note splitting and merging have separate software and UI checks. The model still needs broader representative evaluation, especially multi-procedure notes, cross-section attribution and unusual resuscitations.
