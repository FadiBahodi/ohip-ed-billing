# Folio 1.2 verification

## Software and calculation

`npm test`: 44 passing tests at the time of the release checks. These cover clock defaults, the reported H133 example, clinician overrides, note chronology, semantic procedures, facial-site mapping, critical-care reconstruction, interval subtraction and merging, units, time-premium selection, reassessment spacing, sedation attribution, source-bundle references, backup/CSV provenance, stale model rejection and worker lifecycle.

`npm run build` produces the pinned browser bundles. The source build was run twice against cached official pages and returned the same bundle hash. It uses Lamina's real source ingest, workspace and exact-evidence validator.

## Actual browser inference

See `qa/MODEL_EVALUATION.md` for the three-model comparison, raw outputs, scoped scoring and limitations. The final Qwen3.5 4B pipeline passed the specified checks on twelve synthetic encounters. This is actual on-device inference, not mocked output and not independent clinical validation.

## Connected UI checks

Verified locally:

- Recorded critical-care intervals build G521 + G523 automatically without filling a timing form.
- Recorded afternoon care avoids a spurious current-evening premium.
- Confirming the timeline, copying codes and saving the draft work.
- Adjusting 14:00–14:16 to 14:00–14:20 recalculates the total from 26 to 30 minutes and updates copied chart wording.
- Untimed pressor-treated shock runs through the actual local model and produces a 15-minute estimated timeline and critical-care codes automatically. The model retains the ICU physician's central-line attribution.
- Saving that estimate, reloading the shift and reopening it preserves “Proposed timing”. CSV and JSON downloads were opened and checked: recorded/confirmed versus estimated timing, intervals and the rule-package version are preserved; raw notes and model evidence are absent.
- Restoring the two synthetic records from the downloaded backup succeeds without duplicates.
- At a 320 CSS-pixel viewport, the note, care timeline and actions fit without horizontal page overflow. The recorded respiratory example retains its 33-minute total through actual model inference.
- A 2,288-character synthetic wound note is processed in bounded sections. The repair in its final paragraph reaches Z176 after actual inference; no critical-care proposal is added.

Public deployment and asset freshness are checked after pushing the release. These local checks do not stand in for that live check.

## Coverage limits

Dollar rates and the full current Schedule remain incompletely verified. The new official-guidance bundle supports time recording and critical-care examples for R010–R012; it is not validation of every inherited rule. Estimated physician time is a proposed reconstruction, not a measured fact. Calendar-crossing critical care still needs per-day allocation review. Some anaesthesia listings are outside the focused catalogue. No claims are submitted by this app.
