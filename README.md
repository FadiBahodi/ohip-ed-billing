# Folio

A fast, local-first OHIP billing workspace for emergency medicine.

**Live app:** https://fadibahodi.github.io/ohip-ed-billing/

Paste a clinical encounter, review the proposed codes and supporting evidence, resolve missing facts, and save a billing draft to your shift. Search 190 code entries, 49 service concepts and 50 linked rule cards. Export CSV, print/PDF, or a JSON backup.

## Run

No package installation or build step is required. All scripts, styles and fonts are included in this repository.

```sh
npm start
# http://127.0.0.1:8771

npm test
```

GitHub Pages serves the root of `main`. Asset URLs are relative so the app works under `/ohip-ed-billing/`. Pushing a tested commit to `main` updates the live site.

## What is connected

- The FastBill v3 deterministic extraction, timeline and rule engines, with source-linked evidence.
- Local search across the supplied catalogue, service aliases and rules.
- Question-based corrections, code/plain-language display, clinician-added code lines, unit edits and combination checks.
- Shift drafts stored in this browser, with reviewed/hold status and cross-encounter critical-time checks.
- JSON backup/restore, CSV with formula-injection protection, and print/PDF.

## Data handling

Raw clinical notes and quoted evidence live only in the tab's memory. Switching encounters in the tab preserves working notes; closing or refreshing clears them. Saving a draft stores only its local reference, codes, dates/times, coverage, role, review state and critical-care intervals. These records use browser local storage; Folio does not encrypt them. Use non-identifying references and a trusted device. JSON backups and exports contain billing records and should be handled accordingly.

No clinical note is sent to a model, server or analytics provider. There is no cloud sync or claim-submission integration. The page's Content Security Policy disallows application network connections. Fonts are self-hosted. Following a source link opens its external website.

## Billing coverage

This is **draft decision support**, not a verified current OHIP fee schedule or submission system. The supplied FastBill package was built on 2026-09-04 and explicitly marks current-schedule verification as incomplete. Dollar fees are not bundled. Some mappings need a current-preamble check; those statuses and original source links remain visible.

The ECG profile is currently CVH-oriented (`G313` disabled). Rule-based extraction is bounded and can miss phrasing or context. Review the source chart, roles, times, units, bundling and current service-date requirements. Source-linked manual catalogue entry remains available when extraction is incomplete.

A browser language model and Lamina's ingestion/revalidation pipeline are **not connected in this release**. The existing source IDs, quoted evidence and rule relationships provide the integration boundary for later source maintenance. The app does not label regex extraction as AI.

## Source and changes

`engine/data.js`, `validator.js`, `time.js` and `fastbill.js` were extracted from the user-supplied OHIP FastBill v3 HTML. This release replaces the older keyword-to-code app and its remote bridge. Previous versions remain in Git history. If the former app has a saved `billing_queue` in this browser, “Previous app data” appears in the Shift toolbar. It lets you reopen notes or export the original queue; old storage is never deleted or silently converted into reviewed claims.

The engine changes in Folio are narrow, regression-tested fixes: distinguish another physician from the billing clinician; recognize explicit `I applied` and local/general anaesthetic spelling; ask no redundant cast question when confirmed fracture treatment already includes it; and avoid critical-care prompts from negated critical-care statements.

The UI and shift persistence are new. Google Fonts DM Sans and Manrope are included under their accompanying SIL Open Font License files in `fonts/`.
