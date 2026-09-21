# Folio: automatic billing reconstruction

The product actively reconstructs physician work and proposes the strongest supported bill. Inferred work and estimated time are editable proposals, with one-step confirmation. The original ChatGPT conversation, Browser LLM Billing Analysis, is the product brief.

Release acceptance:

- Compare Qwen3 4B with Qwen3.5 2B/4B on identical synthetic encounters in the browser. Record model, fixture, output, validity, elapsed time and limitations. Choose from observed task performance.
- Automatically construct critical-care billing, reconstruct separate episodes, subtract interruptions and separately payable procedure time, and aggregate minutes before rounding.
- Use note timing when available. Offer editable estimates for implied care; distinguish recorded, reconstructed and confirmed timing through save/export/reopen.
- Connect recognized work, additional capture, assessment alternatives and useful chart wording. Preserve actor, refusal and chronology. Keep sparse-note billing immediate.
- Handle long notes in bounded local passes, preserve evidence, discard stale generations. Inference stays on the device.
- Connect public source ingestion to Lamina's actual evidence pipeline and ship a versioned rule-linked source bundle. Patient notes never enter this source index.
- Verify calculations, browser journeys, shift/export/restore, narrow screens and deployed freshness. Publish to GitHub/Pages.

This release is not complete coverage of every Ontario fee or future payer. Unverified rates and coverage remain visible until checked against applicable primary sources.
