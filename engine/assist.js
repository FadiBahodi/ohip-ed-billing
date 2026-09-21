/* Interaction policy: useful suggestions first, visible assumptions, exact evidence. */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports
      ? require("./fastbill.js")
      : root.FastBill,
    typeof module === "object" && module.exports
      ? require("./time.js")
      : root.FastTime,
    typeof module === "object" && module.exports
      ? require("./care.js")
      : root.FolioCare,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FolioAssist = api;
})(globalThis, function (F, T, Care) {
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
      (!interpretation?.care || interpretation.care.tier === "none") &&
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
          : ["minor", "multisystem", "comprehensive"].includes(
                ctx.defaultAssessment,
              )
            ? ctx.defaultAssessment
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
    for (const r of interpretation?.reassessments || []) {
      const existing = f.reassessments.find((x) => x.time === r.time);
      const event = {
        time: r.time,
        date: f.date,
        evidence: r.quote,
        newOrder: !!existing?.newOrder || r.newCare,
        notDisposition: !!existing?.notDisposition || !r.dispositionOnly,
        reason: r.reason,
        origin: "model",
      };
      if (existing) Object.assign(existing, event);
      else f.reassessments.push(event);
    }
    f.assumptions = assumptions;
    f.interpretation = interpretation;
    return {
      facts: Care.apply(F.applyOverrides(f, ctx), interpretation, ctx, note),
      interpretation,
      assumptions,
    };
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
    const work = arr("work", 1000).map((w) => {
      if (
        typeof w.label !== "string" ||
        w.label.length > 180 ||
        !["documented", "inferred", "possible"].includes(w.certainty) ||
        !F.proof(note, w.quote)
      )
        errors.push("Work needs an exact quote and a stated certainty.");
      return { label: w.label, quote: w.quote, certainty: w.certainty };
    });
    const services = arr("services", 1000).map((e) => {
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
      if (attrs.site)
        attrs.site = F.siteFrom(attrs.site, e.service) || attrs.site;
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
    const opportunities = arr("opportunities", 1000).map((o) => {
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
    const reassessments = [];
    for (const r of obj.reassessments || []) {
      if (
        !F.proof(note, r.quote) ||
        typeof r.reason !== "string" ||
        r.reason.length > 600 ||
        typeof r.newCare !== "boolean" ||
        typeof r.dispositionOnly !== "boolean"
      ) {
        errors.push("Reassessment needs grounded work.");
        continue;
      }
      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ||
        !T.tokens(note, { assume24: true }).some((t) => t.time === r.time)
      )
        continue;
      reassessments.push({ ...r });
    }
    let care = null;
    if (obj.care) {
      const c = obj.care;
      if (
        !["none", "other", "life"].includes(c.tier) ||
        typeof c.reason !== "string" ||
        !F.proof(note, c.quote) ||
        !Array.isArray(c.episodes) ||
        c.episodes.length > 1000
      )
        errors.push("Invalid care reconstruction.");
      else {
        for (const e of c.episodes) {
          if (
            !F.proof(note, e.quote) ||
            typeof e.label !== "string" ||
            e.label.length > 300 ||
            !["care", "excluded"].includes(e.kind) ||
            !["documented", "estimated"].includes(e.timing) ||
            !Number.isInteger(e.minutes) ||
            e.minutes < 0 ||
            e.minutes > 720 ||
            typeof e.start !== "string" ||
            typeof e.end !== "string"
          )
            errors.push("Care episode needs grounded work and valid timing.");
        }
        care = {
          tier: c.tier,
          reason: c.reason,
          quote: c.quote,
          episodes: c.tier === "none" ? [] : c.episodes.map((e) => ({ ...e })),
        };
      }
    }
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
        opportunities: opportunities.filter(
          (o) =>
            !(
              o.pathway === "documentation" &&
              services.some(
                (e) =>
                  ["other", "nurse"].includes(e.actor) &&
                  typeof e.quote === "string" &&
                  typeof o.quote === "string" &&
                  o.quote.length > 0 &&
                  e.quote.includes(o.quote),
              )
            ),
        ),
        care,
        reassessments,
      },
    };
  }
  function serviceSeeds(note, ctx, data) {
    const f = F.localExtract(note, ctx, data);
    const seeds = f.events.map((e) => ({
      service: e.service,
      actor: e.actor,
      status: e.status,
      quote: e.evidence,
      site: e.attrs.site || "unknown",
      anaesthesia: e.attrs.anaesthesia || "unknown",
      purpose: e.attrs.purpose || "unknown",
      length_cm: e.attrs.length_cm || 0,
    }));
    if (f.role === "sedation")
      for (const service of [
        "fracture_reduction",
        "dislocation",
        "cardioversion",
      ])
        if (!seeds.some((s) => s.service === service))
          seeds.push({
            service,
            actor: "unknown",
            status: "performed",
            quote: note,
            site: F.siteFrom(note, service) || "unknown",
            anaesthesia: "sedation",
            purpose: "unknown",
            length_cm: 0,
          });
    return seeds;
  }
  return { clock, suggest, validate, serviceSeeds };
});
