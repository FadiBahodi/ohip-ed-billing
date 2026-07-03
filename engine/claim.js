/**
 * engine/claim.js -- SUBSYSTEM 6 (CLAIM/EXPORT). Pure, deterministic, no network.
 *
 * buildClaim(pickResult, opts) -> { lines, total, text, csv, epicCard, fhir }
 *
 *   pickResult = the object returned by engine/pick.js
 *                { assessment, premiums[], procedures[], claim_line, ..., total, has_unconfirmed }
 *   opts (all optional) = {
 *     ohip:  "..."      // your OHIP billing number. EMPTY by default -- set it in Settings
 *                       // (stored only in your browser's localStorage, never shipped).
 *     group: "..."      // your group billing number. EMPTY by default -- set it in Settings.
 *     date:  "YYYY-MM-DD"// the encounter/claim date. The app passes today's ISO date.
 *     fhir:  true        // set false to omit the FHIR export (default true)
 *   }
 *
 *   lines    = [{code, label, amount}]  one line item per emitted code (amount null if $ unconfirmed)
 *   total    = sum of the confirmed (present, numeric) amounts, 2-dp
 *   text     = one copy-paste claim line (header + codes + $) for pasting into a note / message.
 *              Until OHIP#/group are set in Settings the header shows "OHIP# —" / "Group —".
 *   csv      = biller-ingestible CSV: header + one row per line item (date, OHIP#, group, code, label, amount)
 *   epicCard = terse "enter in Epic Charge Capture: <codes>" cheat card. HONEST GATE: this is what you
 *              type into Epic Charge Capture / Level of Service, or hand the biller. It is NOT a MOH submission.
 *   fhir     = minimal FHIR R4 Claim resource (status draft) for interop export. Not a submission channel.
 *
 * This module invents no code strings and reads no clock except as the date fallback (documented below).
 * Given the same inputs it returns the same output. DO NOT add a second claim builder -- extend this one.
 *
 * PRIVACY: this file ships with NO real billing credentials. ohip/group default to "" and are supplied
 * at runtime from the user's own localStorage (billing_ohip / billing_group). Do not hard-code numbers here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BillingClaim = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // No credentials in source. Empty until the user sets them in Settings (localStorage).
  var DEFAULTS = { ohip: '', group: '', fhir: true };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // "$37.95" for display; "$?" when the $ could not be confirmed against the live SOB.
  function moneyDisp(a) { return isNum(a) ? '$' + a.toFixed(2) : '$?'; }

  // Bare "37.95" for CSV; "" when unconfirmed (biller fills it after verifying vs SOB).
  function moneyCsv(a) { return isNum(a) ? a.toFixed(2) : ''; }

  // Header display: show a dash placeholder until the user sets the value in Settings.
  function orDash(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }

  // RFC-4180 field quoting: wrap in quotes and double internal quotes when the field
  // contains a comma, quote, or newline. Labels can carry commas, so every field is guarded.
  function csvField(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Flatten a pick() result into its ordered line items (assessment, then premiums, then procedures).
  function itemsOf(pr) {
    var items = [];
    if (pr && pr.assessment) items.push(pr.assessment);
    if (pr && pr.premiums) items = items.concat(pr.premiums);
    if (pr && pr.procedures) items = items.concat(pr.procedures);
    return items;
  }

  function buildClaim(pickResult, opts) {
    var pr = pickResult || {};
    opts = opts || {};
    var ohip = opts.ohip !== undefined ? opts.ohip : DEFAULTS.ohip;
    var group = opts.group !== undefined ? opts.group : DEFAULTS.group;
    // The app passes today's ISO date. Fallback reads the clock only when the caller omits it;
    // pass opts.date for a fully deterministic result (the oracle always does).
    var date = opts.date || new Date().toISOString().slice(0, 10);
    var wantFhir = opts.fhir !== undefined ? opts.fhir : DEFAULTS.fhir;

    var items = itemsOf(pr);

    // lines: {code, label, amount}. amount null when the $ is unconfirmed/absent.
    var lines = items.map(function (it) {
      return { code: it.code, label: it.label, amount: isNum(it.amount) ? it.amount : null };
    });

    // total = sum of confirmed (present, numeric) amounts. Unconfirmed items add nothing.
    var sum = 0;
    lines.forEach(function (l) { if (isNum(l.amount)) sum += l.amount; });
    var total = Number(sum.toFixed(2));

    // A "*" marks a line whose $ could not be confirmed against the live Schedule of Benefits.
    function star(it) {
      return (!isNum(it.amount) || it.amount_confirmed === false) ? '*' : '';
    }

    // A percent-premium line (amount_type 'percent_premium') shows "CODE +X% (= $Y)" -- the
    // percent OF the base fee(s), never a flat dollar. it.amount already holds the computed $Y.
    function isPct(it) { return it && it.amount_type === 'percent_premium' && typeof it.percent === 'number'; }
    function codeDisp(it) {
      return isPct(it)
        ? it.code + ' +' + it.percent + '% (= ' + moneyDisp(it.amount) + ')' + star(it)
        : it.code + ' ' + moneyDisp(it.amount) + star(it);
    }

    // ---- text: one copy-paste claim line ----
    var codeSeq = items.map(function (it) { return codeDisp(it); });
    var text =
      'Claim ' + date + '  |  OHIP# ' + orDash(ohip) + '  |  Group ' + orDash(group) + '\n' +
      (codeSeq.length ? codeSeq.join(' + ') + '  =  $' + total.toFixed(2) : '(no codes)') +
      (pr.has_unconfirmed ? '\n* = $ unconfirmed, verify vs live SOB before submitting.' : '');

    // ---- csv: biller-ingestible, one row per line item ----
    var csvRows = ['date,ohip,group,code,label,amount'];
    items.forEach(function (it) {
      csvRows.push([
        csvField(date), csvField(ohip), csvField(group),
        csvField(it.code), csvField(it.label), csvField(moneyCsv(it.amount))
      ].join(','));
    });
    var csv = csvRows.join('\n');

    // ---- epicCard: terse Epic Charge Capture cheat card ----
    var epicLines = items.map(function (it) {
      var amt = isPct(it) ? '+' + it.percent + '% (= ' + moneyDisp(it.amount) + ')' + star(it)
                          : moneyDisp(it.amount) + star(it);
      return '  ' + it.code + '  ' + it.label + '  ' + amt;
    });
    var epicCard =
      'Enter in Epic Charge Capture (' + date + '):\n' +
      (epicLines.length ? epicLines.join('\n') : '  (no codes)') + '\n' +
      'Codes: ' + items.map(function (it) { return it.code; }).join(', ') + '\n' +
      'Total ~ $' + total.toFixed(2) + '\n' +
      'Type into Epic Charge Capture / Level of Service, or hand to the biller. Code advisor, not a MOH submission.';

    var out = { lines: lines, total: total, text: text, csv: csv, epicCard: epicCard };

    // ---- fhir: minimal FHIR R4 Claim (draft). Interop export only, not a submission channel. ----
    if (wantFhir) {
      out.fhir = {
        resourceType: 'Claim',
        status: 'draft',
        use: 'claim',
        created: date,
        extension: [{ url: 'urn:thp:group-billing', valueString: group }],
        provider: {
          identifier: { system: 'https://www.ontario.ca/page/ohip-billing-number', value: ohip }
        },
        priority: { coding: [{ code: 'normal' }] },
        insurance: [{ sequence: 1, focal: true, coverage: { display: 'OHIP' } }],
        item: items.map(function (it, i) {
          var line = {
            sequence: i + 1,
            productOrService: {
              coding: [{
                system: 'https://www.ontario.ca/page/ohip-schedule-benefits-and-fees',
                code: it.code,
                display: it.label
              }]
            }
          };
          if (isNum(it.amount)) line.net = { value: it.amount, currency: 'CAD' };
          return line;
        }),
        total: { value: total, currency: 'CAD' }
      };
    }

    return out;
  }

  return { buildClaim: buildClaim };
});
