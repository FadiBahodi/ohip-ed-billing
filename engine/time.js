/* Date/clock parsing for Ontario ED notes. Pure functions; no network or guessed current date. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FastTime = factory();
})(globalThis, function () {
  "use strict";
  const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const DAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const pad = (n) => String(n).padStart(2, "0");
  function validDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      Number.isInteger(y) &&
      y >= 1900 &&
      y <= 2100 &&
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() + 1 === m &&
      dt.getUTCDate() === d
    );
  }
  function iso(y, m, d) {
    if (!validDate(y, m, d)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  function parseDate(text, year) {
    let m;
    const s = String(text || "").trim();
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)))
      return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/))) {
      let y = +m[3];
      if (y < 100) y += 2000;
      return iso(y, +m[2], +m[1]);
    }
    if (
      (m = s.match(
        /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/,
      ))
    ) {
      let mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      return mo && (+m[3] || year) ? iso(+m[3] || year, mo, +m[2]) : null;
    }
    if (
      (m = s.match(
        /^(\d{1,2})(?:st|nd|rd|th)?[-\s]+([A-Za-z]{3,9})\.?[-\s]+(\d{2}|\d{4})$/,
      ))
    ) {
      let mo = MONTHS[m[2].slice(0, 3).toLowerCase()],
        y = +m[3];
      if (y < 100) y += 2000;
      return mo ? iso(y, mo, +m[1]) : null;
    }
    return null;
  }
  function addDays(date, n) {
    if (!parseDate(date)) throw Error("Invalid calendar date");
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekday(date) {
    return parseDate(date)
      ? DAYS[new Date(date + "T00:00:00Z").getUTCDay()]
      : null;
  }
  function clock(text, opts = {}) {
    let s = String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\./g, ":")
      .replace(/a:m:?/g, "am")
      .replace(/p:m:?/g, "pm")
      .replace(/\s+/g, "");
    if (/^(midnight|0000h?|00:00)$/.test(s))
      return { time: "00:00", minutes: 0, dayOffset: 0, ambiguous: false };
    if (/^(noon|midday)$/.test(s))
      return { time: "12:00", minutes: 720, dayOffset: 0, ambiguous: false };
    if (s === "halfpastmidnight")
      return { time: "00:30", minutes: 30, dayOffset: 0, ambiguous: false };
    let m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|h)?$/),
      compact = false;
    if (!m && (m = s.match(/^(\d{2})(\d{2})(h)?$/))) compact = true;
    if (!m) return null;
    let h = +m[1],
      mi = +(m[2] || 0),
      ap = m[3] || "";
    if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
    if (ap === "am" || ap === "pm") {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (ap === "pm" ? 12 : 0);
      return {
        time: pad(h) + ":" + pad(mi),
        minutes: h * 60 + mi,
        dayOffset: 0,
        ambiguous: false,
      };
    }
    if (h === 24)
      return { time: "00:00", minutes: 0, dayOffset: 1, ambiguous: false };
    let ambiguous = !compact && !opts.assume24 && !ap && h > 0 && h <= 12;
    if (ambiguous && opts.period) {
      if (opts.period === "am" || opts.period === "night") {
        h = h === 12 ? 0 : h;
        ambiguous = false;
      } else if (opts.period === "pm") {
        h = h === 12 ? 12 : h + 12;
        ambiguous = false;
      }
    }
    const r = {
      time: pad(h) + ":" + pad(mi),
      minutes: h * 60 + mi,
      dayOffset: 0,
      ambiguous,
    };
    if (ambiguous)
      r.alternatives = [
        pad(h % 12) + ":" + pad(mi),
        pad((h % 12) + 12) + ":" + pad(mi),
      ];
    return r;
  }
  // A time token must contain ':'/'.', four digits, AM/PM or a named clock. Bare lab values are excluded.
  const TOKEN =
    "(?:\\b(?:[01]?\\d|2[0-4])[:.]\\d{2}\\s*(?:[ap]\\.?m\\.?)?(?!\\d)|\\b(?:[01]\\d|2[0-4])\\d{2}\\s*h?\\b|\\b(?:1[0-2]|0?[1-9])\\s*[ap]\\.?m\\.?|\\bmidnight\\b|\\bnoon\\b)";
  const DATE_RX =
    /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})\b|\b\d{1,2}(?:st|nd|rd|th)?[-\s]+(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)[-\s]+(?:20\d{2}|\d{2})\b|\b(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?)/gi;
  function lines(text) {
    let at = 0;
    return String(text || "")
      .split("\n")
      .map((s) => {
        const o = { text: s, start: at, end: at + s.length };
        at += s.length + 1;
        return o;
      });
  }
  function maskDates(line, year) {
    return line.replace(DATE_RX, (m) =>
      parseDate(m, year) ? " ".repeat(m.length) : m,
    );
  }
  function tokens(text, opts = {}) {
    const out = [];
    const clean = maskDates(String(text), opts.year);
    let m,
      rx = new RegExp(TOKEN, "gi");
    while ((m = rx.exec(clean))) {
      let value = m[0].trim();
      if (
        /^\d{4}$/.test(value) &&
        +value >= 1900 &&
        +value <= 2100 &&
        /\b(year|born|since|in)\s*$/i.test(
          clean.slice(Math.max(0, m.index - 10), m.index),
        )
      )
        continue;
      const c = clock(value, opts);
      if (c)
        out.push({
          ...c,
          raw: value,
          index: m.index,
          end: m.index + m[0].length,
        });
    }
    return out;
  }
  function inferPeriod(text, context = {}) {
    if (context.period) return context.period;
    if (/\b(?:overnight|after midnight|before dawn)\b/i.test(text))
      return "night";
    if (/\b(?:evening|tonight)\b/i.test(text)) return null;
    return null;
  }
  function parse(text, context = {}) {
    const note = String(text || ""),
      ls = lines(note).flatMap((l) => {
        let out = [],
          at = 0,
          rx = /;\s*|\.(?=\s+[A-Za-z])\s+/g,
          m;
        while ((m = rx.exec(l.text))) {
          const t = l.text.slice(at, m.index);
          if (t.trim())
            out.push({ text: t, start: l.start + at, end: l.start + m.index });
          at = m.index + m[0].length;
        }
        const t = l.text.slice(at);
        if (t.trim()) out.push({ text: t, start: l.start + at, end: l.end });
        return out;
      }),
      issues = [],
      dates = [],
      events = [];
    const year = context.date ? Number(context.date.slice(0, 4)) : context.year;
    for (const l of ls) {
      const ms = [...l.text.matchAll(DATE_RX)];
      for (const m of ms) {
        const d = parseDate(m[0], year);
        if (!d) continue;
        let priority = /\b(?:PIA|date of service|service date|DOS)\b/i.test(
          l.text,
        )
          ? 100
          : /\b(?:assessed|physician|patient seen)\b/i.test(l.text)
            ? 90
            : 30;
        if (
          /\b(?:birth|DOB|discharg|follow.up|surgery in|previous|prior|history|since|last admission)\b/i.test(
            l.text,
          )
        )
          priority = 5;
        dates.push({
          date: d,
          priority,
          evidence: m[0],
          line: l.text,
          index: l.start + m.index,
        });
      }
    }
    dates.sort((a, b) => b.priority - a.priority);
    let date = context.date || null,
      dateEvidence = null,
      dateInferred = false;
    if (dates.length && dates[0].priority >= 90) {
      date = dates[0].date;
      dateEvidence = dates[0].evidence;
    } else if (
      !date &&
      dates.length &&
      new Set(dates.filter((d) => d.priority > 5).map((d) => d.date)).size === 1
    ) {
      date = dates.find((d) => d.priority > 5)?.date || null;
      dateEvidence = dates.find((d) => d.priority > 5)?.evidence;
      dateInferred = true;
    }
    const period = inferPeriod(note, context);
    for (const l of ls) {
      let type = null,
        priority = 0;
      if (/\b(?:PIA|physician initial assessment)\s*:/i.test(l.text)) {
        type = "assessment";
        priority = 90;
      }
      if (
        /\b(?:I (?:first )?(?:assessed|saw|evaluated)|patient (?:first )?seen (?:at|@)|actual (?:assessment|PIA))\b/i.test(
          l.text,
        )
      ) {
        type = "assessment";
        priority = 100;
      }
      if (
        /\b(?:initial assessment|assessment time|physician assessment)\b/i.test(
          l.text,
        ) &&
        !type
      ) {
        type = "assessment";
        priority = 85;
      }
      if (
        /\b(?:procedure|reduction|repair|cardioversion|paracentesis|block)\b.{0,30}\b(?:at|start|commenc|time)|\b(?:at|start|commenc)\b.{0,20}\b(?:procedure|reduction|repair)\b/i.test(
          l.text,
        )
      ) {
        type = "procedure";
        priority = 75;
      }
      if (
        /\b(?:sedation|anaesthesia|anesthesia)\b/i.test(l.text) &&
        /\b(?:start|end|time|from|to|at)\b/i.test(l.text)
      ) {
        type = "sedation";
        priority = 75;
      }
      if (
        /\b(?:critical care|resuscitation|resus time|G395|G521|G391)\b/i.test(
          l.text,
        )
      ) {
        type = "critical";
        priority = 80;
      }
      if (/(?:\bR\/a\b|\breassess\w*|\bre-assess\w*)/i.test(l.text)) {
        type = "reassessment";
        priority = 80;
      }
      if (
        /\b(?:triage|arrival|arrived|EMS|prehospital)\b/i.test(l.text) &&
        !/(?:PIA|I assessed)/i.test(l.text)
      ) {
        type = "arrival";
        priority = 10;
      }
      if (/\b(?:signed|time of note|note signed)\b/i.test(l.text)) {
        type = "signature";
        priority = 5;
      }
      if (/\b(?:treatment time|physician time)\b/i.test(l.text) && !type) {
        type = "assessment";
        priority = 85;
      }
      if (!type) continue;
      const ts = tokens(l.text, {
        assume24: /PIA\s*:|^\s*\d{4}\s|ED Course/i.test(l.text),
        period,
        year,
      });
      for (const t of ts)
        events.push({
          ...t,
          type,
          priority,
          evidence: l.text.trim(),
          offset: l.start + t.index,
          date: dates.find((d) => d.line === l.text)?.date || date,
        });
    }
    // Event logs: 01:25 Reassessed ... ; 0013 Asked to see ... .
    for (const l of ls) {
      let m = l.text.match(/^\s*((?:[01]\d|2[0-3]):?\d{2})\s+(.+)/);
      if (!m) continue;
      let type = /asked to see|patient seen|\bassessed\b/i.test(m[2])
        ? "assessment"
        : /reassess|r\/a/i.test(m[2])
          ? "reassessment"
          : /performed|completed|inserted/i.test(m[2])
            ? "procedure"
            : null;
      if (type) {
        const t = clock(m[1], { assume24: true });
        if (t)
          events.push({
            ...t,
            type,
            priority: type === "assessment" ? 95 : 80,
            evidence: l.text.trim(),
            offset: l.start,
            date,
          });
      }
    }
    // Short shorthand: explicit time anywhere (but never steal a triage/signature time).
    if (!events.some((e) => e.type === "assessment")) {
      const relevant = ls.filter(
        (l) =>
          !/(triage|arriv|EMS|signed|DOB|birth|temperature|Pulse|BP:|SpO2|last ate)/i.test(
            l.text,
          ),
      );
      let cands = [];
      for (const l of relevant) {
        const ts = tokens(l.text, { assume24: false, period, year });
        for (const t of ts)
          cands.push({
            ...t,
            type: "assessment",
            priority: 40,
            evidence: l.text.trim(),
            offset: l.start + t.index,
            date,
          });
      }
      if (cands.length === 1) events.push(cands[0]);
    }
    let assessment =
      events
        .filter((e) => e.type === "assessment")
        .sort((a, b) => b.priority - a.priority || a.offset - b.offset)[0] ||
      null;
    if (context.time) {
      const c = clock(context.time, { assume24: true });
      if (c)
        assessment = {
          ...c,
          type: "assessment",
          priority: 110,
          evidence: "Clinician-confirmed time: " + context.time,
          date: context.date || date,
          confirmed: true,
        };
    }
    if (assessment && !context.time) {
      const conflicts = events.filter(
        (e) =>
          e.type === "assessment" &&
          e.priority >= 85 &&
          e.time !== assessment.time,
      );
      if (conflicts.length)
        issues.push({
          id: "time_conflict",
          field: "time",
          message: "Physician times disagree. Select the actual start.",
          options: [
            ...new Set([assessment.time, ...conflicts.map((x) => x.time)]),
          ],
        });
    }
    if (assessment?.ambiguous)
      issues.push({
        id: "time_ambiguous",
        field: "time",
        message: "Is the assessment time AM or PM?",
        options: assessment.alternatives,
      });
    if (assessment?.dayOffset && date)
      date = addDays(date, assessment.dayOffset);
    if (!date && context.shiftDate && assessment) {
      date = context.shiftDate;
      dateInferred = true;
      if (
        context.shiftStart &&
        clock(context.shiftStart, { assume24: true })?.minutes >
          assessment.minutes
      )
        date = addDays(date, 1);
      dateEvidence = "Derived from selected overnight shift";
    }
    if (context.dateConfirmed && context.date) {
      date = context.date;
      dateEvidence = "Clinician-confirmed service date";
    }
    if (!date)
      issues.push({
        id: "date_missing",
        field: "date",
        message:
          "What was the calendar service date? A weekday alone is not enough.",
        options: [],
      });
    if (!assessment)
      issues.push({
        id: "time_missing",
        field: "time",
        message:
          "What time did you assess the patient? Arrival/signing time is not PIA.",
        options: [],
      });
    if (date) {
      const dname = note.match(
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
      );
      if (
        dname &&
        note.length < 350 &&
        dname[1].toLowerCase() !== weekday(date).toLowerCase()
      )
        issues.push({
          id: "weekday_conflict",
          field: "date",
          message: `The stated weekday conflicts with ${date} (${weekday(date)}).`,
          options: [],
        });
    }
    return {
      date,
      time: assessment?.time || null,
      assessment,
      events,
      issues,
      dateEvidence,
      dateInferred,
      weekday: weekday(date),
    };
  }
  function ranges(text, date, opts = {}) {
    const raw = String(text || ""),
      period = opts.period || inferPeriod(raw, opts),
      clean = maskDates(raw, date ? +date.slice(0, 4) : undefined);
    let out = [],
      errors = [],
      rx = new RegExp(
        "(" +
          TOKEN +
          ")\\s*(?:→|->|–|—|\\s-\\s|-(?=\\s*\\d)|\\bto\\b|\\buntil\\b|\\btill\\b)\\s*(" +
          TOKEN +
          ")",
        "gi",
      ),
      m;
    while ((m = rx.exec(clean))) {
      let aRaw = m[1].trim(),
        bRaw = m[2].trim();
      let apA = /p\.?m\.?$/i.test(aRaw)
        ? "pm"
        : /a\.?m\.?$/i.test(aRaw)
          ? "am"
          : null;
      let apB = /p\.?m\.?$/i.test(bRaw)
        ? "pm"
        : /a\.?m\.?$/i.test(bRaw)
          ? "am"
          : null;
      const around = raw.slice(
        Math.max(0, m.index - 80),
        Math.min(raw.length, m.index + m[0].length + 30),
      );
      let assume =
        opts.assume24 ||
        (/(?:G395|G521|G391|critical care|resus)/i.test(around) &&
          /(?:00:|0[1-9]:|1[3-9]:|2[0-3]:|\b[01]\d{3})/.test(m[0]));
      let a = clock(aRaw, { assume24: assume, period: apB || period }),
        b = clock(bRaw, { assume24: assume, period: apA || period });
      if (!a || !b) continue;
      // Explicit 24-hour start after 12 establishes 24-hour notation within this range.
      if (
        !a.ambiguous &&
        (a.minutes >= 780 || aRaw.startsWith("00") || aRaw.startsWith("0")) &&
        b.ambiguous
      )
        b = clock(bRaw, { assume24: true });
      if (
        !b.ambiguous &&
        (b.minutes >= 780 || bRaw.startsWith("00") || bRaw.startsWith("0")) &&
        a.ambiguous
      )
        a = clock(aRaw, { assume24: true });
      if (a.ambiguous || b.ambiguous) {
        errors.push({
          message: "Ambiguous AM/PM in interval: " + m[0],
          evidence: m[0],
        });
        continue;
      }
      let mins = b.minutes - a.minutes;
      if (mins < 0) mins += 1440;
      if (mins === 0) {
        errors.push({
          message: "Zero-length interval: " + m[0],
          evidence: m[0],
        });
        continue;
      }
      if (mins > 720) {
        errors.push({
          message:
            "Interval over 12 hours requires explicit dates and review: " +
            m[0],
          evidence: m[0],
        });
        continue;
      }
      let sd = date ? addDays(date, a.dayOffset) : null,
        ed = sd && (b.minutes < a.minutes || b.dayOffset) ? addDays(sd, 1) : sd;
      out.push({
        start: a.time,
        end: b.time,
        date: sd,
        endDate: ed,
        minutes: mins,
        crossesMidnight: sd !== ed,
        evidence: raw.slice(m.index, m.index + m[0].length),
        offset: m.index,
      });
    }
    // Explicit start/end labels on separate lines.
    if (!out.length) {
      const sr = new RegExp(
          "(?:start(?:ed)?(?:\\s+time)?|commenced)\\s*[:@]?\\s*(" + TOKEN + ")",
          "i",
        ),
        er = new RegExp(
          "(?:end(?:ed)?(?:\\s+time)?|finished)\\s*[:@]?\\s*(" + TOKEN + ")",
          "i",
        );
      let a = raw.match(sr),
        b = raw.match(er);
      if (a && b) {
        let r = ranges(a[1] + " -> " + b[1], date, opts);
        out = r.items.map((i) => ({
          ...i,
          evidence: a[0] + " … " + b[0],
          evidenceParts: [a[0], b[0]],
          offset: a.index,
        }));
        errors.push(...r.errors);
      }
    }
    return {
      items: out,
      errors,
      total: out.reduce((sum, r) => sum + r.minutes, 0),
    };
  }
  function absolute(r) {
    if (!r.date) return null;
    return {
      start:
        Date.parse(r.date + "T00:00Z") / 60000 +
        clock(r.start, { assume24: true }).minutes,
      end:
        Date.parse((r.endDate || r.date) + "T00:00Z") / 60000 +
        clock(r.end, { assume24: true }).minutes,
    };
  }
  function totalExclusive(items) {
    let a = items
        .map((r) => ({ ...r, abs: absolute(r) }))
        .filter((x) => x.abs)
        .sort((a, b) => a.abs.start - b.abs.start),
      overlaps = [];
    for (let i = 1; i < a.length; i++)
      if (a[i].abs.start < a[i - 1].abs.end)
        overlaps.push({ a: a[i - 1], b: a[i] });
    return {
      total: a.reduce((s, r) => s + r.minutes, 0),
      overlaps,
      crossesMidnight: a.some((x) => x.crossesMidnight),
    };
  }
  return {
    clock,
    parseDate,
    validDate,
    addDays,
    weekday,
    parse,
    ranges,
    tokens,
    absolute,
    totalExclusive,
    lines,
  };
});
