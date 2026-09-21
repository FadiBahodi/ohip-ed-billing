# Folio 1.0 verification

Verified locally on 2026-09-21 before the GitHub Pages release.

## Automated

`npm test`: 17 passing regression tests. These cover refused procedures, another physician's work, physician time versus note-signing time, missing information, critical-care interval aggregation and overlap, fracture/cast bundling, code and phrase search, incompatible code variants, safe persistence, backup validation, CSV formula escaping and extraction evidence requirements.

`node --check app.js`, `node --check core.js`, Prettier parsing of HTML/JS/CSS, and `git diff --check` passed. The inherited FastBill report's 361 checks were not available as runnable source and are not represented as rerun here.

## Browser journeys

- A wrist-reduction example creates the assessment, procedure and premium candidates and excludes the bundled cast without a redundant actor question.
- A declined-drainage example produces no drainage code; the earlier assessment time remains the basis of its time band.
- A new synthetic cough note asks for the missing assessment descriptor. Answering it updates the draft; confirmed OHIP coverage is saved.
- Reviewed-draft save, clipboard copy, refresh and reopening work. Restored records retain codes but have no raw note.
- Search finds distal-radius reduction through ordinary language and exact Z101 lookup. Code detail dialogs show source status and linked rules.
- Manual catalogue addition requires confirmation and resets draft review. The code/plain-language toggle changes the same service rows.
- JSON restoration adds a synthetic fixture while preserving existing encounters. CSV and JSON download controls were exercised; CSV content and JSON round-trip behavior were separately checked by the automated tests.
- A measured 391 CSS-pixel viewport has no document-wide horizontal overflow. Notes and drafts stack; shift navigation, review/save and copy remain operable. The shift table scrolls within its container.
- No browser console errors or warnings were captured in the tested journeys.

## Boundaries

Clinical/source verification is distinct from these software checks. Current dollar rates are not bundled, some inherited mappings still need current-Schedule review, the site profile is CVH-oriented, and this version neither submits claims nor runs a language model. Full model/clinical accuracy benchmarking, current-Schedule ingestion and Lamina integration remain future work.
