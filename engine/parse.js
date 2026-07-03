/**
 * engine/parse.js -- deterministic free-text ED case -> structured facts (SUBSYSTEM 4, PARSE).
 * Powers the "Read the case" box. Pure, FREE, no network, no LLM by default.
 *
 * Contract:
 *   parse(text[, opts]) -> {
 *     time_band,            // day | evening | night | weekend_holiday   (rules.json time_bands)
 *     complexity,           // minor | comprehensive | multiple_systems | reassessment |
 *                           // consultation | critical | resus            (rules.json complexity_levels)
 *     procedures: [code],   // procedure code strings the picker stacks on the assessment
 *     special_visit: bool,  // true => call-in / special visit (A-prefix + SVP downstream)
 *     referral_source?      // 'family' | 'specialist'  (only for consultation cases)
 *   }
 *
 * The output feeds engine/pick.js unchanged. This file emits NO code strings that pick.js
 * would not also emit -- it only classifies real ED phrasing into the existing enums + KB codes.
 *
 * TIME-BAND PRECEDENCE (matches rules.json, not the label on band-independent critical cases):
 *   00:00-08:00 -> night on ANY day (weekend included) BEFORE the weekend rule. This is the
 *   correct OHIP behaviour: a Saturday 03:00 minor visit bills the NIGHT code, not a weekend code.
 *
 * OPTIONAL LLM hook: llm(text, opts) exists for a future NL upgrade. It is OFF by default and
 * parse() NEVER calls it. It only runs when a caller explicitly passes opts.apiKey AND opts.useLlm,
 * so the shipped app stays free and offline. No provider wired in -- returns null unless overridden.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BillingParse = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function norm(text) {
    return String(text == null ? '' : text).toLowerCase();
  }

  // ---- TIME BAND ----------------------------------------------------------
  function parseTimeBand(t) {
    var isWeekend = /saturday|sunday|weekend|holiday|statutory/.test(t);

    // 24h clock (disposition time). Take the LAST HHMM -- it is the "seen"/"seen again" stamp.
    var re = /\b([01][0-9]|2[0-3])([0-5][0-9])\b/g, m, last = null;
    while ((m = re.exec(t)) !== null) last = m;
    var hour = last ? parseInt(last[1], 10) : null;

    // am/pm fallback (real ED phrasing: "2am", "11 pm").
    if (hour === null) {
      var ap = /\b(1[0-2]|[1-9])\s*(a\.?m\.?|p\.?m\.?)\b/.exec(t);
      if (ap) {
        var h = parseInt(ap[1], 10) % 12;
        if (/p/.test(ap[2])) h += 12;
        hour = h;
      }
    }

    if (hour !== null) {
      if (hour >= 0 && hour < 8) return 'night';       // night wins on any day, incl. weekends
      if (isWeekend) return 'weekend_holiday';
      if (hour >= 17) return 'evening';
      return 'day';
    }

    // No clock: fall back to words.
    if (/overnight|\bnight\b/.test(t)) return 'night';
    if (isWeekend) return 'weekend_holiday';
    if (/\bevening\b/.test(t)) return 'evening';
    return 'day';
  }

  // ---- COMPLEXITY ---------------------------------------------------------
  // Ordered: the more specific / higher-acuity category wins. consultation and
  // reassessment are checked before "admitted"/"comprehensive" so a referral that
  // mentions an admitted patient still classifies as a consultation.
  function parseComplexity(t) {
    if (/\bconsult/.test(t)) return 'consultation';
    if (/re-?assess|recheck|second look/.test(t)) return 'reassessment';

    var criticalNeg = /not\s+(full\s+)?critical/.test(t);
    if ((/\bcritical\b/.test(t) && !criticalNeg) || /cardiac arrest/.test(t)) return 'critical';
    if (/resus|\bunstable\b/.test(t)) return 'resus';

    if (/multi|\bsystems\b/.test(t)) return 'multiple_systems';

    if (/comprehensive/.test(t) ||
        /full workup/.test(t) ||
        /full\s+[a-z ]{0,25}hx/.test(t) ||
        /complete\s+[a-z ]{0,15}hx/.test(t) ||
        /meds and pmhx/.test(t) ||
        /meds and social/.test(t) ||
        /workup ordered/.test(t) ||
        /\badmitted\b/.test(t)) return 'comprehensive';

    return 'minor';
  }

  // ---- PROCEDURES ---------------------------------------------------------
  // Keyword -> KB code. Every code here exists in data/codes.json. Set-based (order-free).
  function parseProcedures(t) {
    var out = [];
    function add(code) { if (out.indexOf(code) === -1) out.push(code); }

    // Airway + vascular access
    if (/intubat|endotracheal|airway management/.test(t)) add('G211');
    if (/central (venous )?line|central venous/.test(t)) add('G269');
    if (/arterial line/.test(t)) add('G268');
    if (/intraosseous/.test(t)) add('G270');
    if (/arterial blood gas|\babg\b/.test(t)) add('Z459');

    // Chest / cardiac
    if (/chest tube|thoracostomy/.test(t)) add('Z341');
    if (/cardiovers/.test(t)) add('Z437');
    if (/transvenous|pacer|pacemaker|pacing wire/.test(t)) add('Z443');
    // ECG G313 only when interpreted / done for a purpose, NOT merely "ordered" or monitored.
    if (/ecg[^.]*interpret|interpret[^.]*ecg|ecg for\b/.test(t)) add('G313');

    // Neuro / abdo access
    if (/lumbar puncture|\blp\b/.test(t)) add('Z804');
    if (/paracentesis/.test(t)) add('Z591');

    // Soft tissue
    if (/incision and drainage|i ?& ?d\b|abscess/.test(t)) add('Z101');
    if (/nail removal|nail[- ]bed/.test(t)) add('Z128');
    if (/ring block|nerve block|digital block/.test(t)) add('G224');

    // Laceration repair: face/complex vs body/trunk/extremity
    if (/laceration|suture/.test(t)) {
      if (/facial|\bface\b|chin|\blip\b|eyelid|cheek|scalp|forehead|eyebrow|nasal/.test(t)) add('Z154');
      else add('Z176');
    }

    // Splints / casts
    if (/finger splint/.test(t)) add('Z201');
    if (/forearm splint|wrist splint|\barm splint/.test(t)) add('Z203');
    if (/below[- ]knee (cast|splint)|below[- ]knee/.test(t)) add('Z213');

    // Reductions -- gated on an actual reduction/dislocation so "reduced mobility" or a
    // simple "ankle twist" never emit a reduction code. Body part picks the D/F code.
    if (/reduc|disloc/.test(t)) {
      if (/shoulder/.test(t)) add(/without sedation/.test(t) ? 'D015' : (/sedation/.test(t) ? 'D016' : 'D015'));
      if (/elbow/.test(t)) add('D009');
      if (/ankle/.test(t)) add('F075');
      if (/distal radius|colles|smith/.test(t)) add('F028');
    }

    // Procedure premium (evening/weekend/holiday)
    if (/procedure premium/.test(t)) add('E412');

    return out;
  }

  // ---- SPECIAL VISIT + REFERRAL ------------------------------------------
  function parseSpecialVisit(t) {
    return /special (visit|premium)|call(ed)?[- ]?in|from home/.test(t);
  }

  function parseReferralSource(t) {
    if (!/referr|\bconsult/.test(t)) return null;
    if (/family|\bgp\b|ccfp|family (physician|doctor)/.test(t)) return 'family';
    if (/specialist|cardiolog|frcp|internist|surgeon|neurolog/.test(t)) return 'specialist';
    return null;
  }

  // ---- PUBLIC -------------------------------------------------------------
  function parse(text, opts) {
    var t = norm(text);
    var facts = {
      time_band: parseTimeBand(t),
      complexity: parseComplexity(t),
      procedures: parseProcedures(t),
      special_visit: parseSpecialVisit(t)
    };
    var ref = parseReferralSource(t);
    if (ref) facts.referral_source = ref;
    // opts.llm path is intentionally NOT invoked here. See llm() below.
    return facts;
  }

  /**
   * OPTIONAL, OFF BY DEFAULT. Never called by parse(). A future caller can wire a local
   * key + provider to refine ambiguous free text, then reconcile against parse(). Returns
   * null unless a caller supplies opts.apiKey, opts.useLlm===true, and opts.call (the actual
   * request fn). No provider is bundled, so shipped code stays free and offline.
   */
  function llm(text, opts) {
    opts = opts || {};
    if (!opts.useLlm || !opts.apiKey || typeof opts.call !== 'function') return null;
    return opts.call(text, opts); // caller owns the request; nothing here hits the network.
  }

  return { parse: parse, llm: llm };
});
