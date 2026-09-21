/* Reconstruct a proposed care timeline. Estimates remain estimates through export. */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports
      ? require("./time.js")
      : root.FastTime,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FolioCare = api;
})(globalThis, function (T) {
  "use strict";
  const minutes = (s) =>
    /^([01]\d|2[0-3]):[0-5]\d$/.test(s || "")
      ? +s.slice(0, 2) * 60 + +s.slice(3)
      : null;
  const time = (m) =>
    String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0") +
    ":" +
    String(((m % 60) + 60) % 60).padStart(2, "0");
  const union = (items) => {
    const out = [];
    for (const x of [...items].sort((a, b) => a.start - b.start)) {
      const last = out.at(-1);
      if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
      else out.push({ start: x.start, end: x.end });
    }
    return out;
  };
  function subtract(care, excluded) {
    let out = union(care);
    for (const x of union(excluded))
      out = out.flatMap((a) =>
        x.end <= a.start || x.start >= a.end
          ? [a]
          : [
              ...(x.start > a.start ? [{ start: a.start, end: x.start }] : []),
              ...(x.end < a.end ? [{ start: x.end, end: a.end }] : []),
            ],
      );
    return out;
  }
  function careHint(note) {
    const marker =
      /\b(?:G(?:395|391|521|523|522)|critical\s+care|(?:critical\s+)?G[ -]?code|resus(?:citation)?\s+(?:care|time))\b/i;
    const parts = note.split(/(?<=[.!?])\s+|\n+/);
    const explicit = parts.find(
      (s) =>
        marker.test(s) &&
        !/\b(?:no|without|not|never|previous|prior|declined)\b.{0,40}(?:critical|G[ -]?code|G(?:395|391|521|523|522)|resus)/i.test(
          s,
        ),
    );
    if (explicit) {
      const after = explicit.slice(explicit.search(marker));
      const duration =
        after.match(/\b(\d{1,3})\s*(?:min(?:ute)?s?)\b/i) ||
        explicit.match(
          /\b(\d{1,3})\s*(?:min(?:ute)?s?)\b.{0,35}(?:critical|G[ -]?code|G(?:395|391|521|523|522)|resus)/i,
        );
      return {
        explicit: true,
        quote: explicit,
        minutes: duration ? Math.min(720, +duration[1]) : 0,
        tier: /\bG(?:521|523|522)\b|life.threatening/i.test(explicit)
          ? "life"
          : "other",
        reason: "Critical-care pathway from your note.",
      };
    }
    if (/\b(?:no|without)\s+(?:resuscitation|critical\s+care)\b/i.test(note))
      return null;
    const fluids =
      /\b(?:gave|given|started|administered|received|bolus(?:ed|es)?|resuscitat\w*)\b.{0,35}\b(?:fluids?|saline|ringer|LR|NS)\b|\b(?:fluid|saline|crystalloid)\s+(?:bolus|resuscitation)/i.test(
        note,
      );
    const reassessed =
      /r\s*\/\s*a\s*x?\s*[2-9]|reassess\w*|recheck\w*|serial|repeat.{0,20}(?:exam|assessment|perfusion)/i.test(
        note,
      );
    const physiology = [
      ...note.matchAll(
        /\btachy(?:cardi\w*)?\b|hypotens\w*|hypovolemi\w*|severe\s+dehydration/gi,
      ),
    ].some(
      (m) =>
        !/\b(?:no|not|without)\s*$/.test(
          note.slice(Math.max(0, m.index - 16), m.index),
        ),
    );
    if (fluids && reassessed && physiology)
      return {
        explicit: false,
        quote: note,
        minutes: 15,
        tier: "other",
        reason:
          "Fluid resuscitation and repeat assessment · proposed other critical care.",
      };
    return null;
  }
  function normalizedEpisode(e, note, date, cursor) {
    let start = minutes(e.start),
      end = minutes(e.end),
      estimated = e.timing !== "documented";
    // Resolve a malformed model bound from one unambiguous recorded range.
    // Its duration and one bound must agree; the note supplies the correction.
    if (start === end && e.minutes > 0) {
      const matches = T.ranges(note, date, { assume24: true }).items.filter(
        (r) => r.start === e.start && r.minutes === e.minutes,
      );
      if (matches.length === 1) {
        e = { ...e, end: matches[0].end };
        end = minutes(e.end);
      }
    }
    const recordedRange = T.ranges(note, date, { assume24: true }).items.find(
      (r) => r.start === e.start && r.end === e.end,
    );
    if (recordedRange)
      e = {
        ...e,
        quote: recordedRange.evidence || e.quote,
        timing: "documented",
      };
    if (recordedRange) estimated = false;
    const hasClock = (s) =>
      s &&
      (recordedRange ||
        new RegExp("(?:^|\\D)" + s.replace(":", "(?::|)") + "(?:\\D|$)").test(
          e.quote || "",
        ));
    // A model's documented label alone is not temporal evidence. Downgrade
    // unsupported bounds to a visible estimate instead of fabricating a record.
    if (start !== null && !hasClock(e.start)) {
      start = null;
      estimated = true;
    }
    if (end !== null && !hasClock(e.end)) {
      end = null;
      estimated = true;
    }
    let duration =
      Number.isInteger(e.minutes) && e.minutes > 0 && e.minutes <= 720
        ? e.minutes
        : 0;
    if (start !== null && end !== null) {
      if (end < start) end += 1440;
      duration = end - start;
    } else {
      if (!duration) return null;
      if (
        !new RegExp(
          "(?:^|\\D)" + duration + "\\s*(?:min|minutes|minute)\\b",
          "i",
        ).test(e.quote || "")
      )
        estimated = true;
      if (start === null && end !== null) start = end - duration;
      if (start === null) {
        start = cursor;
        estimated = true;
      }
      end = start + duration;
    }
    if (duration <= 0 || duration > 720) return null;
    return {
      ...e,
      start: time(start),
      end: time(end),
      minutes: duration,
      timing: estimated ? "estimated" : "documented",
      a: start,
      b: end,
      date,
    };
  }
  function reconstruct(f, interpretation, ctx = {}, note = "") {
    const manual = ctx.overrides || {},
      semantic = interpretation?.care;
    const hint = careHint(note);
    const stated = [...note.matchAll(
      /\b(?:spent\s+)?(\d{1,3})\s+minutes?\s+(?:of\s+)?(?:active(?:ly)?\s+(?:care|manag\w*|resuscitat\w*|titrat\w*)|(?:critical|resuscitative)\s+care)/gi,
    )];
    const statedDuration =
      stated.length === 1 && +stated[0][1] > 0
        ? { minutes: +stated[0][1], quote: stated[0][0] }
        : null;
    if (
      manual.criticalTier === "none" ||
      manual.exclusive === false ||
      f.role === "assistant" ||
      f.inactive
    )
      return null;
    const tier =
      manual.criticalTier ||
      (hint?.explicit &&
        (/\bG(?:395|391)\b/i.test(hint.quote)
          ? "other"
          : f.critical.tier === "life" || semantic?.tier === "life"
            ? "life"
            : hint.tier)) ||
      (semantic?.tier !== "none" && semantic?.tier) ||
      (["life", "other"].includes(f.critical.tier) ? f.critical.tier : null) ||
      hint?.tier;
    if (!["life", "other"].includes(tier)) return null;
    let episodes = [],
      cursor = minutes(f.time) ?? 0;
    if (Array.isArray(ctx.careEpisodes)) {
      episodes = ctx.careEpisodes
        .map((e) => ({
          ...e,
          quote: e.quote || "",
          timing: ctx.careConfirmed ? "confirmed" : e.timing || "estimated",
          a: minutes(e.start),
          b: minutes(e.end),
        }))
        .filter((e) => e.a !== null && e.b !== null)
        .map((e) => ({ ...e, b: e.b < e.a ? e.b + 1440 : e.b }));
    } else if (manual.intervals || f.critical.intervals.length) {
      episodes = f.critical.intervals.map((r, i) => ({
        label: "Active critical care " + (i + 1),
        quote: r.evidence || f.critical.evidence.join(" "),
        kind: "care",
        start: r.start,
        end: r.end,
        timing: manual.intervals ? "confirmed" : "documented",
        a: minutes(r.start),
        b: minutes(r.end) + (r.crossesMidnight ? 1440 : 0),
      }));
      // Explicit critical-care intervals are primary; model exclusions still
      // matter, but must not add duplicate estimates on top of recorded care.
      for (const e of semantic?.episodes || [])
        if (e.kind === "excluded") {
          const x = normalizedEpisode(e, note, f.date, cursor);
          if (x) episodes.push(x);
        }
    } else {
      const duration = hint?.explicit && hint.minutes ? hint : statedDuration;
      const proposed = duration
        ? [
            {
              label: "Care duration from note · proposed clock times",
              quote: duration.quote,
              kind: "care",
              start: "",
              end: "",
              minutes: duration.minutes,
              timing: "estimated",
            },
          ]
        : semantic?.episodes?.length
          ? semantic.episodes
          : hint
            ? [
                {
                  label: hint.reason,
                  quote: hint.quote,
                  kind: "care",
                  start: "",
                  end: "",
                  minutes: hint.minutes || 15,
                  timing: "estimated",
                },
              ]
            : [];
      for (const e of proposed) {
        const x = normalizedEpisode(e, note, f.date, cursor);
        if (x) {
          episodes.push(x);
          if (e.kind === "care") cursor = x.b;
        }
      }
    }
    if (
      !episodes.some((e) => e.kind === "care") &&
      (hint || ["life", "other"].includes(semantic?.tier))
    ) {
      const fallback = normalizedEpisode(
        {
          label:
            hint?.reason ||
            "15-minute starting estimate · adjust to your active care",
          quote: hint?.quote || semantic.quote,
          kind: "care",
          start: "",
          end: "",
          minutes: hint?.minutes || 15,
          timing: "estimated",
        },
        note,
        f.date,
        cursor,
      );
      if (fallback) episodes.push(fallback);
    }
    if (!episodes.some((e) => e.kind === "care"))
      return {
        tier,
        reason: hint?.explicit
          ? hint.reason
          : semantic?.reason || f.critical.reason,
        episodes: [],
        intervals: [],
        minutes: 0,
        basis: "estimated",
        needsTiming: true,
      };
    const active = episodes
      .filter((e) => e.kind === "care")
      .map((e) => ({ start: e.a, end: e.b }));
    const excluded = episodes
      .filter((e) => e.kind === "excluded")
      .map((e) => ({ start: e.a, end: e.b }));
    const net = subtract(active, excluded),
      total = net.reduce((n, r) => n + r.end - r.start, 0);
    const confirmed =
      ctx.careConfirmed === true ||
      (!!manual.intervals && manual.exclusive === true);
    const basis = confirmed
      ? "confirmed"
      : episodes.some((e) => e.timing === "estimated")
        ? "estimated"
        : "documented";
    const intervals = net.map((r) => ({
      start: time(r.start),
      end: time(r.end),
      date: T.addDays(f.date, Math.floor(r.start / 1440)),
      endDate: T.addDays(f.date, Math.floor(r.end / 1440)),
      minutes: r.end - r.start,
      crossesMidnight: Math.floor(r.start / 1440) !== Math.floor(r.end / 1440),
      evidence:
        basis === "estimated"
          ? "Proposed care reconstruction"
          : "Care timeline",
    }));
    const excludedMinutes =
      union(active).reduce((n, r) => n + r.end - r.start, 0) - total;
    return {
      tier,
      reason: hint?.explicit
        ? hint.reason
        : (semantic?.tier !== "none" && semantic?.reason) ||
          hint?.reason ||
          f.critical.reason,
      episodes,
      intervals,
      minutes: total,
      excludedMinutes,
      basis,
      exclusiveProposed: !confirmed && !f.critical.exclusive,
      confirmed,
      durationFromNote:
        !ctx.careEpisodes &&
        !!((hint?.explicit && hint.minutes) || statedDuration),
      needsTiming: !total,
    };
  }
  function apply(f, interpretation, ctx, note = "") {
    const plan = reconstruct(f, interpretation, ctx, note);
    f.carePlan = plan;
    if (plan?.minutes > 0) {
      f.critical.tier = plan.tier;
      f.critical.intervals = plan.intervals;
      f.critical.exclusive = true;
      f.critical.proposed =
        plan.basis === "estimated" || plan.exclusiveProposed;
      f.critical.timeBasis = plan.basis;
      if (
        plan.basis !== "estimated" &&
        f.assumptions?.some((a) => a.field === "time") &&
        !ctx.time
      ) {
        f.time = plan.intervals[0].start;
        f.assumptions = f.assumptions.filter((a) => a.field !== "time");
      }
      f.critical.reason = plan.reason;
      if (interpretation?.care?.quote)
        f.critical.evidence = [
          ...new Set([...f.critical.evidence, interpretation.care.quote]),
        ];
    }
    return f;
  }
  function documentation(f) {
    const p = f.carePlan,
      work = f.interpretation?.work || [];
    const lines = [];
    if (p?.minutes) {
      lines.push(
        p.basis === "estimated"
          ? "PROPOSED RECONSTRUCTION — timing is estimated; edit before recording."
          : p.confirmed
            ? "Physician-confirmed care timeline."
            : "Draft from note timing; confirm exclusive physician care.",
      );
      lines.push(
        (p.tier === "life" ? "Life-threatening" : "Other") +
          " critical care: " +
          p.reason,
      );
      lines.push(
        p.minutes +
          " minutes of active physician care: " +
          p.intervals.map((x) => x.start + "–" + x.end).join("; ") +
          ".",
      );
      if (p.excludedMinutes)
        lines.push(
          p.excludedMinutes +
            " minutes excluded for interruptions or separately billed work.",
        );
      if (!p.confirmed)
        lines.push(
          "Confirm these intervals reflect your full attention to this patient and exclude separately billed procedure time.",
        );
    }
    for (const w of work)
      lines.push(
        (w.certainty === "documented"
          ? ""
          : w.certainty === "inferred"
            ? "Inferred work to verify: "
            : "Possible work to verify: ") +
          w.label +
          ".",
      );
    return lines.join("\n");
  }
  return {
    minutes,
    time,
    union,
    subtract,
    reconstruct,
    apply,
    documentation,
    careHint,
  };
});
