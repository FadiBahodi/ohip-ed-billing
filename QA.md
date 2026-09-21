# Folio 1.1 verification

Checked on 2026-09-21. Synthetic encounters only.

## Automated

`npm test`: 29 passing tests. The suite covers the reported chest-pain example, Toronto clock and time bands, explicit note timing, clinician overrides, preservation of the working ED assessment when a small model proposes a different descriptor from a sparse note, semantic procedure-to-code compilation, critical-care pathway units, passage-ID grounding, provider attribution, refusals, critical-time overlap and bundling, saved-record field whitelists, backup/CSV behavior, stale model response rejection, worker pause/restart and Qwen's empty thinking prefix.

Syntax checks, the vendor build and `git diff --check` passed. The inherited FastBill report's 361 checks were not available as runnable source and are not represented as rerun here.

## Connected browser checks

- Typing “27 year old female, chest pain, 25 minutes.” produces a working assessment without pressing Update, answering date/time/descriptor questions or checking a review box. At Monday 17:30 the draft is H133. Copy was verified through the browser clipboard.
- The actual Qwen3 4B model downloaded and ran through WebGPU in the Codex Chromium browser. This was real local inference, not a mocked response or a remote model call.
- “I closed the 3 cm forearm cut with stitches under local.” was interpreted as laceration repair and added Z176. The legacy extractor alone found no procedure for that phrasing.
- A hypotension/norepinephrine narrative produced a critical-care opportunity. The ICU fellow's central line was not added to the author's bill. Selecting the critical-care option and entering 16:00–16:20 produced G521 + G523 and removed the ordinary assessment path. The note's 45-minute ED stay was not used as critical-care time.
- Saving without a reference creates an encounter label automatically. A new encounter clears the earlier pathway. The warm model accepted a subsequent note after the cancellation-path fix.
- A measured 366 CSS-pixel viewport had no horizontal document overflow. Draft actions remained available below the note. The note's mobile height was subsequently reduced to bring the draft closer.
- First-generation timings on this device included 8.6–18.0 seconds before evidence-ID optimization; a warm chest-pain interpretation using IDs completed in 7.1 seconds. These are observations, not a latency guarantee. The working draft updates independently after a 100 ms typing debounce.

## Issues found and addressed

The initial 1.7B model produced unrelated work and was rejected. Testing the 4B path uncovered descriptor mistakes, a stale cancellation flag in WebLLM's non-streaming path, malformed quote output and interrupted model downloads. The release uses the 4B model, clearer OHIP context and examples, a stable working ED descriptor, constrained source-passage IDs, the streaming API, stale-response rejection and bounded model-download retries. Pause terminates the worker; retry recreates it while preserving downloaded model caches.

## Limits of this verification

These journeys demonstrate connected behavior, not comprehensive clinical accuracy. The small local model still produces variable reasoning and should be benchmarked across a much larger clinical set. It may miss work, propose an inappropriate descriptor or offer an unhelpful opportunity. Sparse chief complaints preserve the working ED descriptor; alternate model descriptors are visible among the clinician's choices. Focused procedures and explicit descriptors refine that default. The model has a 4096-token context window; very long encounters can exceed it and leave the immediate draft available with an AI error status.

Current dollar rates are not bundled, some inherited mappings still need current-Schedule review, and the site profile remains CVH-oriented. Lamina source ingestion/revalidation and claim submission are not connected. Software tests are separate from current-Schedule validation.
