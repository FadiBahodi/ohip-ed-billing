/**
 * engine/pick.js -- deterministic OHIP ED case->code picker (SUBSYSTEM 3, ENGINE).
 * Pure. No network, no LLM. Single source of truth = data/codes.json + data/rules.json.
 * DO NOT write a second picker. Extend THIS one.
 *
 * Contract:
 *   pick(facts[, data]) -> { assessment, premiums[], procedures[], claim_line, reasoning[], citations[], total, has_unconfirmed }
 *   facts = {
 *     time_band,          // enum id from rules.time_bands: day|evening|night|weekend_holiday
 *     complexity,         // enum id from rules.complexity_levels: minor|comprehensive|multiple_systems|reassessment|critical|resus
 *     procedures: [code], // procedure code strings from codes.json
 *     special_visit: bool,// true => A-prefix assessment + Special Visit Premium
 *     on_call?: bool,     // optional, default false (selects K-prefix vs H9xx SVP)
 *     svp_class?: string  // optional, default "first_person": first_person|additional_person|travel
 *   }
 *   assessment/premiums/procedures items are the full code objects from codes.json.
 *
 * Enums are read verbatim from rules.json / codes.json. This file adds no code strings of its own.
 *
 * data is optional. In Node it self-loads from ../data. In the browser the app passes
 * { codes, rules } (already fetched) so no fs is touched client-side.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BillingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Complexities that bill time-based (G-prefix) instead of an H/A assessment.
  var G_COMPLEXITIES = ['critical', 'resus'];

  // Node-only loader. Never invoked in the browser (app passes data explicitly).
  function loadDataNode() {
    var fs = require('fs');
    var path = require('path');
    var dir = path.join(__dirname, '..', 'data');
    return {
      codes: JSON.parse(fs.readFileSync(path.join(dir, 'codes.json'), 'utf8')),
      rules: JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'))
    };
  }

  function indexCodes(codes) {
    var m = {};
    for (var i = 0; i < codes.length; i++) m[codes[i].code] = codes[i];
    return m;
  }

  function money(amount) {
    return (amount === null || amount === undefined) ? '$?' : '$' + Number(amount).toFixed(2);
  }

  // assessment_map is [{prefix,time_band,complexity,code}]. A/G entries use time_band "any".
  function findAssessmentEntry(rules, prefix, complexity, time_band) {
    for (var i = 0; i < rules.assessment_map.length; i++) {
      var e = rules.assessment_map[i];
      if (e.prefix === prefix && e.complexity === complexity &&
          (e.time_band === time_band || e.time_band === 'any')) {
        return e;
      }
    }
    return null;
  }

  function pick(facts, data) {
    facts = facts || {};
    if (!data) data = loadDataNode();
    var codes = data.codes, rules = data.rules;
    var byCode = indexCodes(codes);

    var time_band = facts.time_band;
    var complexity = facts.complexity;
    var special = facts.special_visit === true;
    var onCall = facts.on_call === true;
    var svpClass = facts.svp_class || 'first_person';

    var reasoning = [];
    var citations = [];
    function cite(url) { if (url && citations.indexOf(url) === -1) citations.push(url); }

    // ---- 1) ASSESSMENT (exactly one per patient) ----
    var assessment = null;
    var svpBlockedReason = null;

    if (complexity === 'consultation') {
      // Consultation codes are not in assessment_map; resolve from codes.json.
      // H055 = specialist/FRCP referral, H065 = family/CCFP-EM referral. facts carry no
      // distinguishing field, so honor optional facts.referral_source, default specialist.
      var refSet = (facts.referral_source === 'family') ? 'family' : 'specialist';
      var cands = codes.filter(function (c) { return c.category === 'assessment' && c.complexity === 'consultation'; });
      var chosen = null;
      for (var ci = 0; ci < cands.length; ci++) {
        var lab = (cands[ci].label || '').toLowerCase();
        if (refSet === 'family' && (lab.indexOf('family') !== -1 || lab.indexOf('ccfp') !== -1)) { chosen = cands[ci]; break; }
        if (refSet === 'specialist' && (lab.indexOf('specialist') !== -1 || lab.indexOf('frcp') !== -1)) { chosen = cands[ci]; break; }
      }
      if (!chosen && cands.length) chosen = cands[0];
      if (chosen) {
        assessment = chosen;
        cite(assessment.source_url);
        reasoning.push('Consultation (' + refSet + ' referral) -> ' + assessment.code + ' (' + assessment.label +
          ', ' + money(assessment.amount) + ').' +
          (facts.referral_source ? '' : ' facts carry no referral_source; defaulted to specialist -- PARSE/UI should set it from the note.'));
      } else {
        reasoning.push('Consultation requested but no consultation code found in KB.');
      }
    } else {
      var targetPrefix;
      if (G_COMPLEXITIES.indexOf(complexity) !== -1) targetPrefix = 'G';   // critical/resus bill time-based
      else if (special) targetPrefix = 'A';                                 // special visit uses A-prefix
      else targetPrefix = 'H';                                              // default ED assessment

      var entry = findAssessmentEntry(rules, targetPrefix, complexity, time_band);

      // Special visit asked but no A-prefix code for this complexity (e.g. reassessment):
      // fall back to the H-prefix assessment and mark the SVP not billable.
      if (!entry && special && targetPrefix === 'A') {
        entry = findAssessmentEntry(rules, 'H', complexity, time_band);
        svpBlockedReason = "no A-prefix assessment exists for complexity '" + complexity + "'";
      }

      if (entry && byCode[entry.code]) {
        assessment = byCode[entry.code];
        cite(assessment.source_url);
        reasoning.push(
          'Assessment: time_band=' + (time_band || 'n/a') + ' x complexity=' + (complexity || 'n/a') +
          ' -> ' + assessment.code + ' (' + assessment.label + ', ' + money(assessment.amount) + ').'
        );
      } else {
        reasoning.push('Assessment: no code matched time_band=' + time_band + ' complexity=' + complexity + '. Check facts.');
      }
    }

    // ---- 2) SPECIAL VISIT PREMIUM (A-prefix gated) ----
    // A call-in trip bills the travel premium ONCE plus a per-person premium.
    // First patient of the trip (default) = travel + first_person; a later patient = additional_person only.
    var premiums = [];
    if (special) {
      if (assessment && assessment.prefix === 'A') {
        var bucket = onCall ? rules.svp_map.on_call : rules.svp_map.not_on_call;
        var band = bucket ? bucket[time_band] : null;
        if (band) {
          var wanted;
          if (svpClass === 'additional_person') wanted = ['additional_person'];
          else if (svpClass === 'travel') wanted = ['travel'];
          else wanted = ['travel', 'first_person'];
          var emitted = [];
          for (var w = 0; w < wanted.length; w++) {
            var svpCode = band[wanted[w]];
            if (svpCode && byCode[svpCode]) { premiums.push(byCode[svpCode]); cite(byCode[svpCode].source_url); emitted.push(svpCode); }
          }
          cite(rules.sources ? rules.sources.DC_QRG : null);
          reasoning.push(
            'Special visit (' + (onCall ? 'on-call' : 'not on-call') + ', ' + time_band + ', ' +
            svpClass.replace(/_/g, ' ') + '): ' + emitted.join(' + ') +
            '. Travel premium bills once per trip alongside the per-person premium; SVP requires the A-prefix assessment.'
          );
        } else {
          reasoning.push('Special visit requested but no SVP band for time_band=' + time_band + '.');
        }
      } else {
        reasoning.push('Special visit requested but ' + (svpBlockedReason || 'assessment is not A-prefix') +
          '; SVP not billable (cannot attach a Special Visit Premium to an H-prefix ED code).');
      }
    }

    // ---- 3) PROCEDURES (stack on top of the assessment) ----
    var procedures = [];
    var reqProcs = facts.procedures || [];
    for (var p = 0; p < reqProcs.length; p++) {
      var pc = reqProcs[p];
      if (byCode[pc]) {
        procedures.push(byCode[pc]);
        cite(byCode[pc].source_url);
      } else {
        procedures.push({
          code: pc, label: 'UNKNOWN CODE (not in KB)', prefix: (pc && pc[0]) || '',
          category: 'procedure', amount: null, amount_confirmed: false, source_url: null
        });
        reasoning.push('Procedure ' + pc + ' not found in KB; emitted as-is, verify against SOB.');
      }
    }
    if (procedures.length) {
      reasoning.push('Procedures stack on the assessment: ' +
        procedures.map(function (x) { return x.code; }).join(', ') + '.');
    }

    // ---- 4) CLAIM LINE (codes + $) ----
    var lineItems = [];
    if (assessment) lineItems.push(assessment);
    lineItems = lineItems.concat(premiums).concat(procedures);
    var total = 0, anyUnconfirmed = false;
    var parts = lineItems.map(function (it) {
      if (it.amount === null || it.amount === undefined) anyUnconfirmed = true;
      else total += Number(it.amount);
      return it.code + ' ' + money(it.amount) + (it.amount_confirmed === false ? '*' : '');
    });
    var claim_line = parts.join(' + ');
    if (parts.length) claim_line += ' = $' + total.toFixed(2);
    if (anyUnconfirmed) claim_line += ' (items marked * = $ unconfirmed, verify vs live SOB)';

    return {
      assessment: assessment,
      premiums: premiums,
      procedures: procedures,
      claim_line: claim_line,
      reasoning: reasoning,
      citations: citations,
      total: Number(total.toFixed(2)),
      has_unconfirmed: anyUnconfirmed
    };
  }

  return { pick: pick, loadDataNode: loadDataNode };
});
