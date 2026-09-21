# Folio

A fast, local-first OHIP billing workspace for emergency medicine.

**Live app:** https://fadibahodi.github.io/ohip-ed-billing/

Type an encounter and get a proposed bill automatically. Today and now are the defaults, shown as editable chips. A local language model interprets shorthand, recognizes physician work and proposes additional billing opportunities. Copy the codes or save a draft directly. Search 190 code entries, 49 service concepts and 50 linked rule cards; export CSV, print/PDF or a JSON backup.

## Run

The static app includes its compiled scripts, styles and fonts. No install is needed to serve it. Local AI requires a WebGPU-capable browser and downloads Qwen3 4B model assets on first use (the WebLLM registry estimates about 3.4 GB of GPU memory). Later visits reuse the browser's model cache. The immediate draft does not wait for the model.

```sh
npm start
# http://127.0.0.1:8771

npm test

# Only needed when changing src/semantic*.js:
npm ci
npm run build
```

GitHub Pages serves the root of `main`. Asset URLs are relative so the app works under `/ohip-ed-billing/`. Pushing a tested commit to `main` updates the live site.

## What is connected

- Immediate suggestions while typing, with Toronto date/time defaults, explicit note timing and clinician corrections taking precedence.
- Qwen3 4B inference through WebLLM in a background worker. Its structured interpretation covers assessment, recognized work, catalogue procedures, provider roles, status and additional capture opportunities.
- The FastBill v3 timeline and rule engines map recognized services to code combinations. Model output cannot create arbitrary fee codes. Evidence quotations and explicit measurements are checked before interpretation is applied.
- Local search across the supplied catalogue, service aliases and rules.
- The working ED descriptor is retained for sparse chief complaints; model alternatives remain selectable. Focused procedures and explicit descriptors refine the default. One-click assessment changes, code/plain-language display, clinician-added lines and units, and combination checks. Material missing details refine the draft; date/time/descriptor questions no longer gate the initial suggestion. Copy and Save do not require a review checkbox.
- Shift drafts stored in this browser, with reviewed/hold status and cross-encounter critical-time checks.
- JSON backup/restore, CSV with formula-injection protection, and print/PDF.

## Data handling

Raw clinical notes and quoted evidence live only in the tab's memory. Switching encounters in the tab preserves working notes; closing or refreshing clears them. Saving a draft stores only its local reference, codes, dates/times, coverage, role, review state and critical-care intervals. These records use browser local storage; Folio does not encrypt them. Use non-identifying references and a trusted device. JSON backups and exports contain billing records and should be handled accordingly.

No clinical note is sent to a remote model, server or analytics provider. Inference runs in the browser worker. Network requests download model assets from Hugging Face/CDNs and the WebLLM project's GitHub artifact host; the worker restricts fetches to GET requests to those artifact origins and the app's own origin. The page also restricts network destinations through Content Security Policy. Model weights are cached; notes and inference output are not added to model caches or saved billing records. There is no cloud sync or claim-submission integration. Fonts are self-hosted. Following a source link opens its external website.

The AI status shows loading, interpretation, readiness or failure. Unsupported browsers retain the immediate draft and manual tools. Pause and retry are available from that status control. Older responses are discarded when the note changes. In-tab encounter switching retains the encounter clock and completed interpretation. First-use loading and inference speed depend on the device and connection.

## Billing coverage

This is **draft decision support**, not a verified current OHIP fee schedule or submission system. The supplied FastBill package was built on 2026-09-04 and explicitly marks current-schedule verification as incomplete. Dollar fees are not bundled. Some mappings need a current-preamble check; those statuses and original source links remain visible.

The ECG profile is currently CVH-oriented (`G313` disabled). Suggestions distinguish explicit and inferred work; inferred work is a proposal for the physician, not an automatically completed chart statement. Duration alone is not converted into critical-care minutes. Procedure time defaults to encounter time when absent, with the assumption shown in evidence; it can be corrected in the procedure details. Source-linked manual catalogue entry remains available.

Lamina's ingestion/revalidation pipeline is not yet connected. Existing source IDs, quoted evidence and rule relationships provide the integration boundary for source maintenance. Browser inference is connected separately from that pipeline; the interface distinguishes an immediate working assessment from an AI-interpreted encounter.

## Source and changes

`engine/data.js`, `validator.js`, `time.js` and `fastbill.js` were extracted from the user-supplied OHIP FastBill v3 HTML. This release replaces the older keyword-to-code app and its remote bridge. Previous versions remain in Git history. If the former app has a saved `billing_queue` in this browser, “Previous app data” appears in the Shift toolbar. It lets you reopen notes or export the original queue; old storage is never deleted or silently converted into reviewed claims.

The engine changes in Folio are narrow, regression-tested fixes: distinguish another physician from the billing clinician; recognize explicit `I applied` and local/general anaesthetic spelling; ask no redundant cast question when confirmed fracture treatment already includes it; and avoid critical-care prompts from negated critical-care statements.

The UI and shift persistence are new. Google Fonts DM Sans and Manrope are included under their accompanying SIL Open Font License files in `fonts/`.
