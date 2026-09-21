/* OHIP Billing Workbench 2 — deterministic decision-support, not a coverage engine. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BillingEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const H_ASSESS = new Set(
    [
      101, 102, 103, 104, 121, 122, 123, 124, 131, 132, 133, 134, 151, 152, 153,
      154,
    ].map((x) => "H" + x),
  );
  const G_OTHER = new Set(["G395", "G391"]),
    G_LIFE = new Set(["G521", "G523", "G522"]);
  const OTHER = new Set(["H112", "H113", "H114"]);
  function clock(s) {
    if (!/^\d{2}:\d{2}$/.test(s || ""))
      throw Error("Use a 24-hour time, HH:MM.");
    const [h, m] = s.split(":").map(Number);
    if (h > 23 || m > 59) throw Error("Time is outside 00:00–23:59.");
    return h * 60 + m;
  }
  function day(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || ""))
      throw Error("An explicit service date (YYYY-MM-DD) is required.");
    const d = new Date(s + "T00:00:00Z");
    if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== s)
      throw Error("Invalid calendar date.");
    return d;
  }
  function stamp(date, time) {
    return +day(date) / 60000 + clock(time);
  }
  function dateAt(min) {
    return new Date(min * 60000).toISOString().slice(0, 10);
  }
  function band(date, time, holiday = false) {
    const w = day(date).getUTCDay(),
      t = clock(time);
    if (t < 480) return "night";
    if (
      holiday ||
      w === 0 ||
      w === 6 ||
      (w === 5 && t >= 1020 && date >= "2026-04-01")
    )
      return "weekend";
    return t >= 1020 ? "evening" : "day";
  }
  function assessment(date, time, level, holiday = false) {
    const n = { minor: 1, comprehensive: 2, multisystem: 3, reassessment: 4 }[
      level
    ];
    if (!n) throw Error("Select an assessment descriptor.");
    return (
      "H" +
      ({ day: 100, evening: 130, night: 120, weekend: 150 }[
        band(date, time, holiday)
      ] +
        n)
    );
  }
  function otherPremium(date, time, holiday = false) {
    return {
      night: "H112",
      weekend: "H113",
      evening: date >= "2026-04-01" ? "H114" : null,
      day: null,
    }[band(date, time, holiday)];
  }
  function procedurePremium(date, time, holiday = false) {
    const t = clock(time),
      w = day(date).getUTCDay();
    if (t < 420) return "E413";
    if (holiday || w === 0 || w === 6 || t >= 1020) return "E412";
    return null;
  }
  function sedationPremium(date, time, holiday = false) {
    const p = procedurePremium(date, time, holiday);
    return p === "E413" ? "E401C" : p === "E412" ? "E400C" : null;
  }
  function svpPeriod(date, time, holiday = false) {
    const t = clock(time),
      w = day(date).getUTCDay();
    let k =
      t < 420
        ? "night"
        : holiday || w === 0 || w === 6
          ? "weekend"
          : t >= 1020
            ? "evening"
            : "day";
    return {
      key: date + "_" + k,
      period: k,
      ...{
        day: {
          travel: "H960",
          first: "H980",
          additional: "H981",
          cap: 5,
          tripCap: 2,
        },
        evening: {
          travel: "H962",
          first: "H984",
          additional: "H985",
          cap: 5,
          tripCap: 2,
        },
        weekend: {
          travel: "H963",
          first: "H988",
          additional: "H989",
          cap: 10,
          tripCap: 4,
        },
        night: {
          travel: "H964",
          first: "H986",
          additional: "H987",
          cap: null,
          tripCap: null,
        },
      }[k],
    };
  }
  function svpChoice(date, time, prior, holiday = false) {
    if (!Number.isInteger(prior) || prior < 0)
      throw Error("Previous patient count must be a nonnegative integer.");
    const p = svpPeriod(date, time, holiday);
    return {
      ...p,
      patientCode:
        p.cap !== null && prior >= p.cap
          ? null
          : prior === 0
            ? p.first
            : p.additional,
      remaining: p.cap === null ? null : Math.max(0, p.cap - prior - 1),
    };
  }
  function intervals(text, date) {
    day(date);
    const rows = String(text || "")
      .trim()
      .split(/[;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!rows.length) throw Error("Enter actual start–stop intervals.");
    let out = [];
    for (let row of rows) {
      const m = row.match(
        /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})\s*(?:->|–|—|-)\s*(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})$/,
      );
      if (!m)
        throw Error(
          "Invalid interval: " +
            row +
            ". Use HH:MM-HH:MM, with full dates for midnight crossings.",
        );
      const sd = m[1] || date,
        ed = m[3] || sd;
      const start = stamp(sd, m[2]),
        end = stamp(ed, m[4]);
      if (end <= start)
        throw Error(
          "End must be after start; explicitly date the next day when crossing midnight.",
        );
      if (end - start > 1440)
        throw Error("An interval over 24 hours needs manual review.");
      out.push({
        start,
        end,
        startDate: sd,
        startTime: m[2],
        endDate: ed,
        endTime: m[4],
        minutes: end - start,
      });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 1; i < out.length; i++)
      if (out[i].start < out[i - 1].end)
        throw Error(
          "Overlapping intervals within this encounter; do not count the same minute twice.",
        );
    return {
      items: out,
      total: out.reduce((a, b) => a + b.minutes, 0),
      crossesDay: out.some((i) => i.startDate !== date || i.endDate !== date),
    };
  }
  function criticalUnits(minutes, tier) {
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw Error("Positive qualifying minutes required.");
    if (!["other", "life"].includes(tier))
      throw Error("Choose other or life-threatening critical care.");
    let n = Math.ceil(minutes / 15);
    return tier === "other"
      ? [
          { code: "G395", units: 1 },
          ...(n > 1 ? [{ code: "G391", units: n - 1 }] : []),
        ]
      : [
          { code: "G521", units: 1 },
          ...(n > 1 ? [{ code: "G523", units: 1 }] : []),
          ...(n > 2 ? [{ code: "G522", units: n - 2 }] : []),
        ];
  }
  function anaesthesiaUnits(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw Error("Positive continuous anaesthesia minutes required.");
    return (
      Math.ceil(Math.min(minutes, 60) / 15) +
      Math.ceil(Math.min(Math.max(minutes - 60, 0), 30) / 15) * 2 +
      Math.ceil(Math.max(minutes - 90, 0) / 15) * 3
    );
  }
  function parseCodes(text) {
    const out = [];
    for (let token of String(text || "").split(/[+,;\n]+/)) {
      token = token.trim();
      if (!token) continue;
      const m = token.match(/^([A-Z]\d{3}[ABC]?)(?:\s*[x×*]\s*(\d+))?$/i);
      if (!m) throw Error("Unrecognized code expression: " + token);
      const units = +(m[2] || 1);
      if (units < 1 || units > 100)
        throw Error("Units must be between 1 and 100.");
      out.push({ code: m[1].toUpperCase(), units });
    }
    return out;
  }
  function line(items) {
    return items
      .map((i) => i.code + (i.units > 1 ? " ×" + i.units : ""))
      .join(" + ");
  }
  function words(s) {
    return (
      String(s)
        .toLowerCase()
        .match(/[a-z0-9]+/g) || []
    );
  }
  function retrieve(query, data, top = 7) {
    const q = Array.from(new Set(words(query))),
      exact = q.filter((t) => /^[a-z]\d{3}[abc]?$/.test(t));
    const linked = new Set();
    for (let c of data.codes)
      if (exact.includes(c.code.toLowerCase()))
        for (let r of c.rule_ids) linked.add(r);
    let docs = data.rules;
    const n = docs.length,
      df = {};
    for (let d of docs) {
      let ts = new Set(
        words(d.title + " " + d.keywords.join(" ") + " " + d.body),
      );
      for (let t of q) if (ts.has(t)) df[t] = (df[t] || 0) + 1;
    }
    let avg = docs.reduce((a, d) => a + words(d.body).length, 0) / n;
    return docs
      .map((d) => {
        const ts = words(d.title + " " + d.keywords.join(" ") + " " + d.body);
        const freq = {};
        for (let t of ts) freq[t] = (freq[t] || 0) + 1;
        let score = 0;
        for (let t of q) {
          const f = freq[t] || 0;
          if (!f) continue;
          let idf = Math.log(
            1 + (n - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5),
          );
          score +=
            (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * ts.length) / avg));
        }
        if (linked.has(d.id)) score += 30;
        return { ...d, score };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(top, 20)));
  }
  function overlaps(records) {
    let found = [];
    for (let i = 0; i < records.length; i++) {
      const a = records[i];
      if (!a.criticalIntervals || a.excluded) continue;
      for (let j = i + 1; j < records.length; j++) {
        const b = records[j];
        if (!b.criticalIntervals || b.excluded) continue;
        for (let x of a.criticalIntervals)
          for (let y of b.criticalIntervals) {
            let n = Math.min(x.end, y.end) - Math.max(x.start, y.start);
            if (n > 0)
              found.push({
                a: a.encounterId,
                b: b.encounterId,
                minutes: n,
                reason:
                  "Same physician, overlapping claimed critical-care time",
              });
          }
      }
    }
    return found;
  }
  function validateCodes(items, data, ctx = {}) {
    let errors = [],
      warnings = [];
    const cs = items.map((i) => i.code),
      has = (c) => cs.includes(c),
      crit = cs.some((c) => G_OTHER.has(c) || G_LIFE.has(c)),
      ha = cs.some((c) => H_ASSESS.has(c));
    for (let c of cs)
      if (!data.codes.some((x) => x.code === c))
        errors.push(
          c +
            ": not in this catalog; retrieve the current descriptor before adding it.",
        );
    if (new Set(cs).size !== cs.length)
      errors.push("Duplicate code rows; consolidate units only if permitted.");
    for (const i of items)
      if (
        ["G395", "G521", "G523", "H112", "H113", "H114"].includes(i.code) &&
        i.units !== 1
      )
        errors.push(
          i.code +
            ": expected one base/period unit in this encounter; distinct episodes require specific rule review.",
        );
    if (cs.filter((c) => OTHER.has(c)).length > 1)
      errors.push(
        "Multiple other-service time-band premiums require separate service/time review.",
      );
    if (has("K623") && (ha || cs.some((c) => /^A00[137]$/.test(c))))
      errors.push(
        "K623 includes its assessment; do not duplicate that work with another core assessment.",
      );
    if (
      (has("E400C") || has("E401C")) &&
      !cs.some((c) => /^[DFZ]\d{3}C$/.test(c))
    )
      errors.push(
        "Anaesthesia percentage premium lacks the applicable C-suffix service.",
      );
    if (has("E400C") && has("E401C"))
      errors.push(
        "Two anaesthesia after-hours premiums require distinct case/commencement review.",
      );
    if (ha && (has("H055") || has("H065")))
      errors.push(
        "Routine assessment and formal consultation for the same work need eligibility review, not automatic stacking.",
      );
    if (cs.some((c) => G_OTHER.has(c)) && cs.some((c) => G_LIFE.has(c)))
      errors.push(
        "Do not mix critical-care tiers without a specific verified transition rule.",
      );
    if (has("G391") && !has("G395"))
      errors.push(
        "G391 needs its eligible base/physician-role pathway; no base documented.",
      );
    if ((has("G523") || has("G522")) && !has("G521"))
      errors.push("Additional life-threatening units lack G521.");
    if (has("G522") && !has("G523"))
      errors.push("G522 shown without second-quarter-hour G523.");
    if (ha && cs.some((c) => OTHER.has(c)))
      errors.push(
        "H112/H113/H114 cannot be stacked with the normal ED assessment for the same work.",
      );
    if (ha && cs.some((c) => /^H98\d$/.test(c)))
      errors.push(
        "Special-visit patient premium with ordinary H-assessment: conflicting pathways.",
      );
    if (crit && ha)
      errors.push(
        "Assessment plus critical care: hold for the exact separate-service payment clause; do not duplicate the same work.",
      );
    if (cs.some((c) => /^A00[137]$/.test(c)) && ha)
      errors.push("Competing A/H core assessments for the same encounter.");
    if (cs.some((c) => /^H98\d$/.test(c)) && (has("E412") || has("E413")))
      errors.push(
        "E412/E413 not automatically payable with A-prefix special visits.",
      );
    if (has("E412") && has("E413"))
      errors.push(
        "Two procedure time bands on one list need separate dated procedures.",
      );
    if (
      cs.some((c) => ["G264", "G265", "G291", "G292"].includes(c)) &&
      (has("E412") || has("E413"))
    )
      errors.push(
        "Occipital-block premium not supported by the reviewed eligible-procedure list; hold pending current authority.",
      );
    if (has("G224"))
      warnings.push(
        "G224 is not routine local infiltration. Verify its specific block/preamble requirements.",
      );
    if (has("H100"))
      warnings.push(
        "H100: verify eligible indication, saved images and report; exclude separately billed procedure time from G-time.",
      );
    if (has("H264") || has("E432A"))
      warnings.push(
        "2026 speculum code: full current pairing/limits are not verified in this package.",
      );
    if (
      cs.some((c) => ["Z201", "Z202", "Z203", "Z211", "Z213"].includes(c)) &&
      cs.some((c) => /^F\d{3}$/.test(c))
    )
      errors.push(
        "Possible bundled fracture treatment plus cast/splint. Verify separate payment before export.",
      );
    if (has("F028") && has("F046"))
      errors.push(
        "Two distal-radius reduction variants; select the actual anaesthetic pathway.",
      );
    if (ctx.role === "assistant" && items.length)
      errors.push(
        "Assistance alone does not establish an independent claim. Verify eligible B units or a separate service.",
      );
    if (ctx.role === "operator" && cs.some((c) => /^[DFZ]\d{3}C$/.test(c)))
      errors.push(
        "Operator cannot also claim separate anaesthesia for the same procedure.",
      );
    if (ctx.ecgAllowed === false && has("G313"))
      errors.push("G313 is disabled in this site profile.");
    if (crit)
      warnings.push(
        "Time arithmetic is not proof of clinical critical-care eligibility; verify each interval and current payment rules.",
      );
    return { errors, warnings };
  }
  function draft(c, data, ledger = []) {
    let items = [],
      errors = [],
      warnings = [],
      iv = null,
      period = null;
    const add = (code, units = 1) => {
      if (code) items.push({ code, units });
    };
    try {
      day(c.date);
      clock(c.time);
    } catch (e) {
      return { items, errors: [e.message], warnings, criticalIntervals: [] };
    }
    if (!c.encounterId)
      errors.push(
        "Add an encounter ID, distinct from patient ID and shift ID.",
      );
    if (c.status === "not_active")
      return {
        items: [],
        errors: [],
        warnings: ["Excluded: explicitly marked not active."],
        excluded: true,
      };
    if (!c.payer || c.payer === "unknown")
      warnings.push(
        "Coverage unverified. A missing OHIP number is NOT an uninsured determination.",
      );
    if (c.date < "2026-04-01")
      warnings.push(
        "Historical date: some current codes may not apply; verify effective dates.",
      );
    if (c.pathway === "critical") {
      try {
        iv = intervals(c.intervals, c.date);
        if (iv.crossesDay)
          errors.push(
            "Critical-care dates cross a calendar boundary; allocate service dates before submitting.",
          );
        items.push(...criticalUnits(iv.total, c.tier || "other"));
        if (!c.criticalConfirmed)
          errors.push(
            "Confirm qualifying clinical threat, actual resuscitative care, and exclusive time excluding separately billed procedures.",
          );
        add(otherPremium(c.date, iv.items[0].startTime, c.holiday));
      } catch (e) {
        errors.push(e.message);
      }
    } else if (c.pathway === "svp") {
      if (!c.svpConfirmed)
        errors.push(
          "Confirm Table V eligibility, outside-hospital request, travel and request documentation.",
        );
      let prev = Number(c.svpPrior);
      try {
        period = svpChoice(c.date, c.time, prev, c.holiday);
        if (period.patientCode) {
          if (!["A001", "A003", "A007"].includes(c.aCode))
            errors.push("Select a supported A-prefix assessment.");
          else add(c.aCode);
          add(period.patientCode);
          if (c.newTrip) {
            if (!c.tripId)
              errors.push(
                "Provide an actual trip ID; clock boundaries do not generate travel.",
              );
            else if (
              ledger.some((x) => x.tripId === c.tripId && x.travelClaimed)
            )
              errors.push("Travel already recorded for this trip ID.");
            else if (
              period.tripCap !== null &&
              new Set(
                ledger
                  .filter(
                    (x) => x.svpPeriodKey === period.key && x.travelClaimed,
                  )
                  .map((x) => x.tripId),
              ).size >= period.tripCap
            )
              errors.push(
                "Travel-premium period maximum reached in this ledger.",
              );
            else add(period.travel);
          }
        } else {
          add(assessment(c.date, c.time, c.level, c.holiday));
          warnings.push(
            "Table V patient allowance exhausted: ordinary H-code fallback.",
          );
        }
      } catch (e) {
        errors.push(e.message);
      }
    } else if (c.pathway === "other") {
      if (!c.otherConfirmed)
        errors.push(
          "Confirm another insured service was personally rendered and an assessment is not payable.",
        );
      add(otherPremium(c.date, c.time, c.holiday));
    } else {
      try {
        add(assessment(c.date, c.time, c.level, c.holiday));
      } catch (e) {
        errors.push(e.message);
      }
      if (c.level === "reassessment") {
        if (!c.reassessConfirmed)
          errors.push(
            "Confirm medically necessary reassessment, timing, daily limits and non-disposition work.",
          );
        if (c.lastAssessment) {
          try {
            if (
              stamp(c.date, c.time) -
                stamp(c.lastDate || c.date, c.lastAssessment) <
              120
            )
              errors.push("Less than two hours since prior assessment.");
          } catch (e) {
            errors.push(e.message);
          }
        } else
          errors.push(
            "Previous physician assessment time needed for a reassessment.",
          );
        if (c.newOrderRequired && !c.newOrder)
          errors.push("This local profile requires a new order/intervention.");
      }
    }
    let extra = [];
    try {
      extra = parseCodes(c.procedures);
    } catch (e) {
      errors.push(e.message);
    }
    if (
      c.pathway !== "critical" &&
      extra.some((i) => G_OTHER.has(i.code) || G_LIFE.has(i.code))
    )
      errors.push(
        "Use the timed critical-care pathway so clinical and time requirements are checked.",
      );
    items.push(...extra);
    if (extra.length && !c.performed)
      errors.push(
        "Confirm the selected additional services were personally performed and documented.",
      );
    if (c.pathway === "other" && extra.length === 0)
      errors.push("An other-service premium cannot stand alone.");
    if (c.addProcedurePremium) {
      if (!c.procedureTime)
        errors.push("Procedure commencement time needed for E412/E413.");
      else if (c.pathway === "svp" && period && period.patientCode)
        errors.push(
          "Do not automatically add procedure premium to a special-visit claim.",
        );
      else if (!c.premiumConfirmed)
        errors.push(
          "Verify exact procedure eligibility under current E412/E413 preamble.",
        );
      else {
        let eligible = extra.some((x) => {
          const z = data.codes.find((k) => k.code === x.code);
          return (
            z &&
            [
              "candidate_surgical_check_preamble",
              "listed_historical_GP104",
            ].includes(z.premium_eligibility)
          );
        });
        if (!eligible)
          errors.push(
            "No selected procedure appears eligible in the reviewed list.",
          );
        else {
          add(
            procedurePremium(
              c.procedureDate || c.date,
              c.procedureTime,
              c.holiday,
            ),
          );
        }
      }
    }
    if (c.role === "sedation") {
      if (c.pathway !== "other")
        errors.push(
          "Separate sedation does not establish a second ED assessment. Use the other-service pathway or verify a genuinely distinct assessment.",
        );
      if (!c.anaesthesiaVerified)
        errors.push(
          "Confirm the full anaesthetic claim-unit calculation, including base, weighted time and eligible modifiers; time units alone are not the complete claim.",
        );
      if (!extra.some((x) => /^[DFZ]\d{3}C$/.test(x.code)))
        errors.push("Select the applicable C-suffix anaesthesia service.");
      warnings.push(
        "Sedation units must include verified base + weighted continuous time + eligible modifiers. Use the time worksheet; x units are not automatically time-only.",
      );
    }
    const v = validateCodes(items, data, {
      role: c.role,
      ecgAllowed: c.ecgAllowed,
    });
    errors.push(...v.errors);
    warnings.push(...v.warnings);
    const rec = {
      encounterId: c.encounterId,
      criticalIntervals: iv ? iv.items : [],
    };
    const conflicts = overlaps([
      ...ledger.filter((x) => x.encounterId !== c.encounterId),
      rec,
    ]);
    for (let x of conflicts)
      if (x.a === c.encounterId || x.b === c.encounterId)
        errors.push(
          "Critical time overlaps " +
            (x.a === c.encounterId ? x.b : x.a) +
            " by " +
            x.minutes +
            " minute(s).",
        );
    return {
      items,
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      criticalIntervals: iv ? iv.items : [],
      totalMinutes: iv ? iv.total : null,
      period,
      source_ids: [
        ...new Set(
          items.flatMap(
            (i) =>
              (data.codes.find((x) => x.code === i.code) || {}).source_ids ||
              [],
          ),
        ),
      ],
      reviewOnly: true,
    };
  }
  function money(base, premiumPct, sharePct) {
    for (let [k, v] of Object.entries({ base, premiumPct, sharePct }))
      if (!Number.isFinite(v) || v < 0) throw Error("Invalid " + k);
    if (sharePct > 100 || premiumPct > 1000)
      throw Error("Check percent values.");
    const gross =
      Math.round((base * (1 + premiumPct / 100) + Number.EPSILON) * 100) / 100;
    return {
      base,
      premiumPct,
      gross,
      sharePct,
      receipt:
        Math.round(((gross * sharePct) / 100 + Number.EPSILON) * 100) / 100,
    };
  }
  function csvCell(x) {
    let s = String(x ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function ledgerCSV(rows) {
    const head = [
      "encounter_id",
      "patient_ref",
      "coverage",
      "health_number_unvalidated",
      "shift_id",
      "service_date",
      "service_time",
      "status",
      "codes",
      "review_state",
      "warnings",
    ];
    const lines = [head.map(csvCell).join(",")];
    for (let r of rows) {
      if (r.excluded) continue;
      lines.push(
        [
          r.encounterId,
          r.patientRef,
          r.payer,
          r.healthNumber,
          r.shiftId,
          r.date,
          r.time,
          r.status,
          line(r.result.items),
          r.reviewed ? "physician-reviewed draft" : "unreviewed draft",
          [...r.result.errors, ...r.result.warnings].join(" | "),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\r\n");
  }
  function validateModel(o, data) {
    let errors = [];
    if (!o || typeof o !== "object" || Array.isArray(o))
      return ["Expected a JSON object."];
    for (let k of [
      "documented_facts",
      "missing_facts",
      "candidates",
      "excluded",
      "questions",
    ])
      if (!Array.isArray(o[k])) errors.push(k + " must be an array.");
    if (Array.isArray(o.candidates))
      for (let i of o.candidates) {
        if (!data.codes.some((c) => c.code === i.code))
          errors.push("Unknown candidate code: " + i.code);
        if (!["supported_candidate", "conditional", "hold"].includes(i.status))
          errors.push(i.code + ": invalid status.");
        if (!Number.isInteger(i.units) || i.units < 1 || i.units > 100)
          errors.push(i.code + ": invalid units.");
        if (
          !Array.isArray(i.rule_ids) ||
          !i.rule_ids.length ||
          i.rule_ids.some((id) => !data.rules.some((r) => r.id === id))
        )
          errors.push(i.code + ": valid rule_ids required.");
        if (typeof i.evidence !== "string" || !i.evidence.trim())
          errors.push(i.code + ": source evidence required.");
      }
    return errors;
  }
  return {
    clock,
    day,
    stamp,
    dateAt,
    band,
    assessment,
    otherPremium,
    procedurePremium,
    sedationPremium,
    svpPeriod,
    svpChoice,
    intervals,
    criticalUnits,
    anaesthesiaUnits,
    parseCodes,
    line,
    retrieve,
    overlaps,
    validateCodes,
    draft,
    money,
    ledgerCSV,
    validateModel,
  };
});
