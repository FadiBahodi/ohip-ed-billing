/* Interaction policy: useful suggestions first, visible assumptions, exact evidence. */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports
      ? require("./fastbill.js")
      : root.FastBill,
    typeof module === "object" && module.exports
      ? require("./time.js")
      : root.FastTime,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FolioAssist = api;
})(globalThis, function (F, T) {
  "use strict";
  function clock(now = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(now)
        .map((x) => [x.type, x.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
      zone: "America/Toronto",
    };
  }
  function suggest(note, ctx, data, now = clock(), semantic = null) {
    const f = F.localExtract(note, ctx, data);
    const assumptions = [];
    if (!f.date) {
      f.date = /\byesterday\b/i.test(note) ? T.addDays(now.date, -1) : now.date;
      assumptions.push({
        field: "date",
        value: f.date,
        source: /\byesterday\b/i.test(note) ? "yesterday" : "today",
      });
    }
    if (!f.time) {
      f.time = now.time;
      assumptions.push({ field: "time", value: f.time, source: "now" });
    }
    f.timeline.issues = f.timeline.issues.filter(
      (i) => !["date_missing", "time_missing"].includes(i.id),
    );
    for (const e of f.events) if (!e.date) e.date = f.date;
    for (const r of f.critical.intervals) {
      if (!r.date) r.date = f.date;
      if (!r.endDate)
        r.endDate = r.crossesMidnight ? T.addDays(r.date, 1) : r.date;
    }
    let interpretation = null;
    if (semantic) {
      const checked = validate(semantic, note, data);
      if (checked.ok) {
        interpretation = checked.value;
        for (const e of interpretation.services) {
          const existing = f.events.find((x) => x.service === e.service);
          const event = {
            service: e.service,
            label: data.services.find((s) => s.id === e.service).label,
            actor: e.actor,
            status: e.status,
            evidence: e.quote,
            date: f.date,
            time: existing?.time || null,
            attrs: { ...(existing?.attrs || {}), ...e.attrs },
            origin: "model",
            proof: F.proof(note, e.quote),
          };
          if (existing) {
            Object.assign(existing, event);
          } else f.events.push(event);
        }
      }
    }
    const explicit = f.assessment.level;
    const literal = note.match(/\bH(?:10|12|13|15)([123])\b/i);
    const suggestedLevel = interpretation?.assessment?.level;
    // A sparse chief complaint does not tell us the assessment was narrower
    // than the clinician's working ED default. Preserve that default; the
    // model can refine focused procedure encounters and explicit descriptors.
    const focusedProcedure = interpretation?.services.some(
      (e) =>
        e.actor === "self" &&
        e.status === "performed" &&
        [
          "laceration",
          "abscess",
          "nail_excision",
          "fracture_reduction",
          "dislocation",
          "foreign_body",
        ].includes(e.service),
    );
    const useModelDescriptor =
      suggestedLevel === "multisystem" ||
      (suggestedLevel === "minor" && focusedProcedure);
    if (
      suggestedLevel === "none" &&
      !ctx.role &&
      !explicit &&
      interpretation.services.some(
        (e) => e.actor === "self" && e.status === "performed",
      )
    ) {
      f.role = "procedure_only";
    }
    if (
      !explicit &&
      !ctx.overrides?.level &&
      !["assistant", "procedure_only", "sedation"].includes(f.role)
    ) {
      const level = literal
        ? { 1: "minor", 2: "comprehensive", 3: "multisystem" }[literal[1]]
        : useModelDescriptor
          ? suggestedLevel
          : "multisystem";
      f.assessment = {
        level,
        evidence: interpretation?.assessment?.quote || "",
        suggested: true,
        reason:
          (useModelDescriptor ? interpretation?.assessment?.reason : "") ||
          (literal
            ? "Assessment descriptor from the code you entered."
            : "Working ED assessment. Change it if the actual assessment was narrower or comprehensive."),
        origin:
          interpretation && useModelDescriptor ? "model" : "practice-default",
      };
    }
    if (interpretation && explicit && !ctx.overrides?.level)
      f.assessment.reason = interpretation.assessment.reason;
    if (ctx.overrides?.level)
      f.assessment.reason = "Assessment selected by you.";
    for (const e of f.events) {
      if (
        e.status === "performed" &&
        e.actor === "self" &&
        !e.time &&
        !ctx.overrides?.events?.[e.service]?.time
      ) {
        e.time = f.time;
        e.timeAssumed = true;
      }
    }
    const criticalOpportunity = interpretation?.opportunities.find((o) =>
      o.pathway.startsWith("critical_"),
    );
    if (criticalOpportunity) {
      f.critical.evidence = [
        ...new Set([...f.critical.evidence, criticalOpportunity.quote]),
      ];
      f.critical.reason = criticalOpportunity.detail;
    }
    f.assumptions = assumptions;
    f.interpretation = interpretation;
    return { facts: F.applyOverrides(f, ctx), interpretation, assumptions };
  }
  function validate(value, note, data) {
    const errors = [];
    const obj = value;
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
      return { ok: false, errors: ["Expected an interpretation."] };
    if (
      !obj.assessment ||
      !["minor", "multisystem", "comprehensive", "none"].includes(
        obj.assessment.level,
      )
    )
      errors.push("Invalid assessment suggestion.");
    if (
      typeof obj.assessment?.reason !== "string" ||
      obj.assessment.reason.length > 600
    )
      errors.push("Invalid assessment reasoning.");
    if (obj.assessment?.quote && !F.proof(note, obj.assessment.quote))
      errors.push("Assessment evidence is not in the note.");
    const arr = (key, max) => {
      if (!Array.isArray(obj[key]) || obj[key].length > max) {
        errors.push("Invalid " + key);
        return [];
      }
      return obj[key];
    };
    const work = arr("work", 12).map((w) => {
      if (
        typeof w.label !== "string" ||
        w.label.length > 180 ||
        !["documented", "inferred", "possible"].includes(w.certainty) ||
        !F.proof(note, w.quote)
      )
        errors.push("Work needs an exact quote and a stated certainty.");
      return { label: w.label, quote: w.quote, certainty: w.certainty };
    });
    const services = arr("services", 15).map((e) => {
      if (
        !data.services.some((s) => s.id === e.service) ||
        !["self", "other", "nurse", "unknown"].includes(e.actor) ||
        !["performed", "planned", "refused", "historical", "negated"].includes(
          e.status,
        ) ||
        !F.proof(note, e.quote)
      )
        errors.push("Service needs an exact quote, actor and status.");
      const attrs = {};
      for (const key of ["site", "anaesthesia", "purpose"])
        if (typeof e[key] === "string" && e[key] && e[key] !== "unknown")
          attrs[key] = e[key];
      if (e.length_cm > 0 && e.length_cm <= 200) {
        if (
          !new RegExp(
            String(e.length_cm).replace(".", "\\.") + "\\s*(?:cm|centimet)",
          ).test(e.quote)
        )
          errors.push("Measured length is absent from its quote.");
        else attrs.length_cm = e.length_cm;
      }
      return {
        service: e.service,
        actor: e.actor,
        status: e.status,
        quote: e.quote,
        attrs,
      };
    });
    const opportunities = arr("opportunities", 5).map((o) => {
      if (
        typeof o.title !== "string" ||
        o.title.length > 150 ||
        typeof o.detail !== "string" ||
        o.detail.length > 700 ||
        !F.proof(note, o.quote)
      )
        errors.push("Opportunity needs its supporting quote.");
      return {
        title: o.title,
        detail: o.detail,
        quote: o.quote,
        pathway: [
          "critical_life",
          "critical_other",
          "reassessment",
          "documentation",
          "other",
        ].includes(o.pathway)
          ? o.pathway
          : "other",
      };
    });
    return {
      ok: !errors.length,
      errors,
      value: {
        assessment: {
          level: obj.assessment?.level,
          reason: obj.assessment?.reason,
          quote: obj.assessment?.quote || "",
        },
        work,
        services,
        opportunities,
      },
    };
  }
  return { clock, suggest, validate };
});
