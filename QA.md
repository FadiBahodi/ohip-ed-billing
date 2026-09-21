# Folio verification

## Folio 1.3

`npm test`: 55 passing tests. See `qa/LATENCY_EVALUATION.md` for measured speed, the exact G-code regression, direct clock editing, pending-model interaction, save/reload and narrow-screen verification. The final 4B interpretation plus calculator passes all sixteen scoped cases. Public release freshness is checked after publication.

## Folio 1.2 software and calculation

`npm test`: 45 passing tests at the time of the release checks. These cover clock defaults, the reported H133 example, clinician overrides, note chronology, semantic procedures, facial-site mapping, critical-care reconstruction, interval subtraction and merging, units, time-premium selection, reassessment spacing, sedation attribution, source-bundle references, backup/CSV provenance, stale model rejection and worker lifecycle.

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

Public verification of release `fbdcdd0` passed on GitHub Pages: the deployment completed successfully and all eleven checked HTML/script/style assets matched the local SHA-256 hashes. In a fresh public tab, the reported chest-pain note produced H133 immediately, retained it after Qwen3.5 interpretation, and copied H133 to the clipboard. The untimed shock note automatically produced a 15-minute estimated timeline with G521 + H114.

That live run exposed a redundant central-line attribution reminder because its evidence was a shorter span of already resolved ICU-operator evidence. The 1.2.1 patch removes that reminder and adds a regression using the captured model output while retaining unrelated documentation opportunities. Confirming proposed care and changing the assessment clock preserves the confirmed interval clocks. A stray null text node in the expanded procedure evidence was also removed. The final deployed patch and recorded-care journey are verified after publication.

## Coverage limits

Dollar rates and the full current Schedule remain incompletely verified. The new official-guidance bundle supports time recording and critical-care examples for R010–R012; it is not validation of every inherited rule. Estimated physician time is a proposed reconstruction, not a measured fact. Calendar-crossing critical care still needs per-day allocation review. Some anaesthesia listings are outside the focused catalogue. No claims are submitted by this app.
