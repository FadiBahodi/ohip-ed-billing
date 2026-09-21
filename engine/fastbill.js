/* FastBill 3: evidence-tagged event extraction + rule compilation. */
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./time.js"), require("./validator.js"));
  else root.FastBill = factory(root.FastTime, root.BillingEngine);
})(globalThis, function (T, V) {
  "use strict";
  const deep = (x) => JSON.parse(JSON.stringify(x));
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const unique = (a) => [...new Set(a)];
  const rex = (s, f = "i") => new RegExp(s, f);
  const has = (s, r) => rex(r).test(s);
  function proof(note, quote) {
    if (typeof quote !== "string" || !quote.trim()) return null;
    const i = note.indexOf(quote);
    if (i >= 0) return { quote, start: i, end: i + quote.length };
    const n = note.replace(/\s+/g, " ").trim(),
      q = quote.replace(/\s+/g, " ").trim();
    return q.length >= 8 && n.includes(q)
      ? { quote, start: null, end: null, whitespaceNormalized: true }
      : null;
  }
  function statements(note) {
    let out = [],
      rx = /[^\n.!?]+(?:[.!?](?!\d)|$)/g,
      m; // line split preserves decimal concentrations and timestamp context
    for (const l of T.lines(note)) {
      let parts = l.text.split(/(?<=[.!?])\s+(?=[A-Z])/),
        p = 0;
      for (const s of parts) {
        const i = l.text.indexOf(s, p);
        if (s.trim())
          out.push({
            text: s.trim(),
            start: l.start + i,
            end: l.start + i + s.length,
          });
        p = i + s.length;
      }
    }
    return out;
  }
  function assertion(text) {
    const s = text.toLowerCase();
    if (
      /\b(?:no|without)\s+(?:(?:a|an|any)\s+)?(?:intubation|cardioversion|paracentesis|lumbar puncture|chest compressions|CPR|resuscitation|critical\s+care|nerve block|laceration repair|drainage)\b/i.test(
        s,
      )
    )
      return "negated";
    if (
      /\b(?:declined|refused|not performed|not done|cancelled|canceled|deferred|not required|did not (?:perform|insert|place|reduce|drain)|never performed)\b/.test(
        s,
      )
    )
      return "refused";
    if (
      /\b(?:previous|previously|prior|history of|last (?:week|month|year)|\d+\s+(?:days?|weeks?|months?)\s+ago)\b/.test(
        s,
      )
    )
      return "historical";
    if (
      /\b(?:will|plan(?:ned)?(?: to| for)?|offered|consider(?:ed)?|might|may need|if needed|recommend(?:ed)?)\b/.test(
        s,
      ) &&
      !/\b(?:subsequently|then|later|now)\b.{0,35}(?:performed|completed|inserted|placed)/.test(
        s,
      )
    )
      return "planned";
    return "performed";
  }
  function actor(text, role) {
    const s = text.toLowerCase();
    if (
      /\bi\s+(?:personally\s+)?(?:performed|inserted|placed|applied|reduced|repaired|drained)|\bby me\b/.test(
        s,
      )
    )
      return "self";
    if (
      /\b(?:nurs(?:e|ing)|rn|ems|paramedic|orthotech)\b.{0,35}\b(?:inserted|placed|performed|applied)|\bby\s+(?:the\s+)?(?:nurse|nursing|ems|paramedic)/.test(
        s,
      )
    )
      return "nurse";
    if (
      /\b(?:another|other|colleague|primary operator)\b.{0,35}\b(?:physician|doctor|doc|performed|operator)|\b(?:performed|inserted|placed)\s+by\s+(?:(?:the|icu|ed|another)\s+)?(?:dr|physician|doctor)\b/.test(
        s,
      )
    )
      return "other";
    if (role === "assistant") return "other";
    return "unknown";
  }
  const SITES = [
    [
      "distal_radius",
      /distal\s+rad(?:ius|ial)|colles|smith|barton|wrist\s+(?:fracture|#)/i,
    ],
    ["metatarsal", /metatarsal|fifth\s+mt|5th\s+mt/i],
    ["metacarpal", /metacarpal/i],
    ["bennett", /bennett/i],
    ["finger", /finger|thumb|phalange.*hand|digital/i],
    ["toe", /toe|phalange.*foot/i],
    ["elbow", /elbow|olecranon|supracondylar/i],
    ["radial_head", /nursemaid|pulled\s+elbow|radial\s+head/i],
    ["forearm", /forearm|radius\s+or\s+ulna/i],
    ["shoulder", /shoulder|glenohumeral/i],
    ["humeral_neck", /humer(?:al|us)\s+neck/i],
    ["humeral_shaft", /humer(?:al|us)\s+shaft/i],
    ["patella", /patella/i],
    ["ankle", /ankle|malleol/i],
    ["tibia", /tibia/i],
    ["calcaneus", /calcaneus|calcaneal/i],
    ["knee", /knee/i],
    ["hip", /hip\s+(?:disloc|joint)|dislocat.*hip/i],
    [
      "face",
      /face|facial|eyebrow|supraorbital|vermilion|lip\b|chin|cheek|eyelid/i,
    ],
    ["nose", /nasal\s+bone|nose\s+fracture/i],
    ["hand", /thenar|hand|palm/i],
    ["arm", /upper\s+arm|arm/i],
    ["leg", /thigh|lower[ -]+leg|shin|calf|\bleg\b/i],
    ["foot", /foot/i],
    ["trunk", /trunk|torso|chest|abdomen|back/i],
  ];
  function siteFrom(text, id) {
    if (id === "laceration") {
      for (const k of [
        "face",
        "finger",
        "hand",
        "ankle",
        "leg",
        "arm",
        "foot",
        "trunk",
      ]) {
        const x = SITES.find((s) => s[0] === k);
        if (x[1].test(text)) return k;
      }
      return null;
    }
    if (
      id === "dislocation" &&
      /nursemaid|pulled\s+elbow|radial\s+head/i.test(text)
    )
      return "radial_head";
    if (/bennett/i.test(text)) return "bennett";
    if (/olecranon/i.test(text) && id === "fracture_reduction")
      return "olecranon";
    for (const [id, r] of SITES) if (r.test(text)) return id;
    return null;
  }
  function method(text) {
    if (/\b(?:no|without)\s+(?:sedation|anaesthesia|anesthesia)\b/i.test(text))
      return /hematoma\s+block|haematoma\s+block|lidocaine|local|regional/i.test(
        text,
      )
        ? "local"
        : "none";
    if (/general\s+an(?:ae|e)sthe(?:sia|tic)/i.test(text)) return "general";
    if (
      /ketamine|etomidate|propofol|procedural\s+sedation|conscious\s+sedation|deep\s+sedation/i.test(
        text,
      )
    )
      return "sedation";
    if (
      /hematoma\s+block|haematoma\s+block|lidocaine|local\s+infiltration|local\s+an(?:ae|e)sthe(?:sia|tic)|regional\s+block/i.test(
        text,
      )
    )
      return "local";
    return "unknown";
  }
  function roleFrom(note) {
    if (
      /\bI\s+(?:only\s+)?(?:helped|assisted)\b|\bassisting\s+physician\s*:\s*(?:me|self)\b/i.test(
        note,
      ) &&
      !/\bI\s+(?:was\s+the\s+)?primary\s+operator/i.test(note)
    )
      return "assistant";
    if (
      /\b(?:I|my role).{0,20}(?:only\s+sedated|sedation.only|sedation physician)|\bI\s+provided\s+sedation.{0,80}(?:another|other|colleague)\b/i.test(
        note,
      )
    )
      return "sedation";
    if (
      /\b(?:procedure.only|came\s+over\s+only\s+to\s+perform|only\s+performed\s+the\s+procedure)\b/i.test(
        note,
      )
    )
      return "procedure_only";
    if (/\b(?:active\s+handover|active\s+hand.?off)\b/i.test(note))
      return "handover";
    return "primary";
  }
  function localExtract(note, context, data) {
    const t0 = performance.now(),
      timeline = T.parse(note, context),
      ss = statements(note);
    let events = [],
      role = context.role || roleFrom(note),
      warnings = [];
    // Build performed events by linking each action to its nearest explicit anatomical subject.
    // This is a bounded event grammar, not a claim of general language understanding.
    for (const def of data.services) {
      let candidates = [];
      for (let i = 0; i < ss.length; i++) {
        const current = ss[i],
          direct = rex(def.pattern).test(current.text),
          act = rex(def.action).test(current.text);
        const related = ss
          .slice(Math.max(0, i - 5), i)
          .filter(
            (x) =>
              current.start - x.end < 650 &&
              rex(def.pattern).test(x.text) &&
              assertion(x.text) === "performed",
          );
        let subject = direct ? current : related.at(-1),
          linked = false;
        if (!direct) {
          if (!act || !subject) continue;
          // Avoid generic "performed" attaching unrelated procedures. Link only precise actions.
          const precise = {
            fracture_reduction:
              /closed reduction|reduced|fragment manipulation/i,
            dislocation: /closed reduction|reduced|reduction/i,
            laceration:
              /sutured|sutures? (?:placed|inserted)|(?:repaired|closed) (?:with|using)|wound (?:closed|repaired)/i,
            abscess: /incis(?:ed|ion)|pus (?:drained|expressed)|drained/i,
            paracentesis: /ascitic fluid|paracentesis/i,
            thoracentesis: /pleural fluid|thoracentesis/i,
            occipital:
              /lidocaine.*inject|inject.*lidocaine|block (?:performed|completed)/i,
          };
          if (!precise[def.id]?.test(current.text)) continue;
          linked = true;
        }
        const status = assertion(current.text);
        if (!act) {
          if (direct && status !== "performed")
            candidates.push({
              service: def.id,
              label: def.label,
              status,
              actor: actor(current.text, role),
              evidence: current.text,
              offset: current.start,
              attrs: {},
            });
          continue;
        }
        // Do not claim an immobilization fracture-treatment code for a reduction already documented.
        const around = [
          ...ss.slice(Math.max(0, i - 2), i),
          current,
          ...ss.slice(i + 1, i + 3),
        ]
          .map((x) => x.text)
          .join(" ");
        const windowText = (linked ? subject.text + " " : "") + current.text;
        const attributeText = windowText + " " + around;
        let a = actor(current.text, role),
          attrs = {
            site: siteFrom(windowText, def.id),
            anaesthesia: method(windowText),
          };
        if (!attrs.site) attrs.site = siteFrom(attributeText, def.id);
        if (!attrs.site) {
          const prior = related
            .slice()
            .reverse()
            .find((x) => siteFrom(x.text, def.id));
          if (prior) {
            attrs.site = siteFrom(prior.text, def.id);
            if (!linked) subject = prior;
          }
        }
        if (
          ["fracture_reduction", "dislocation", "abscess"].includes(def.id) &&
          attrs.anaesthesia === "unknown"
        )
          attrs.anaesthesia = method(around);
        if (/\bright\b/i.test(windowText)) attrs.side = "right";
        if (/\bleft\b/i.test(windowText))
          attrs.side = attrs.side === "right" ? "unclear" : "left";
        if (/bilateral|both\s+sides/i.test(windowText))
          attrs.side = "bilateral";
        const lengths = [
          ...attributeText.matchAll(/\b(\d+(?:\.\d+)?)\s*cm\b/gi),
        ].filter(
          (m) =>
            !/(?:needle|catheter|from the|landmark)/i.test(
              attributeText.slice(Math.max(0, m.index - 40), m.index),
            ),
        );
        if (lengths.length) attrs.length_cm = +lengths[0][1];
        if (def.id === "laceration" && !attrs.length_cm) {
          const lm = note.match(
            /(?:laceration|wound|repaired\s+length)[^\n.]{0,65}?\b(\d+(?:\.\d+)?)\s*cm\b|\b(\d+(?:\.\d+)?)\s*cm\b[^\n.!?]{0,50}(?:laceration|wound)/i,
          );
          if (lm) attrs.length_cm = +(lm[1] || lm[2]);
        }
        attrs.count = /\b(?:bilateral|two abscesses|2 abscesses)\b/i.test(
          attributeText,
        )
          ? 2
          : /\b(?:three|3)\s+(?:or more\s+)?abscess/i.test(attributeText)
            ? 3
            : 1;
        attrs.purpose = /\btherapeutic\b/i.test(windowText)
          ? "therapeutic"
          : /\bdiagnostic\b/i.test(windowText)
            ? "diagnostic"
            : /\bdiagnostic\b/i.test(around)
              ? "diagnostic"
              : "unknown";
        if (def.id === "abscess" && /perianal/i.test(attributeText))
          attrs.site = "perianal";
        if (def.id === "nail_excision")
          attrs.radical =
            /phenol|destroy.*nail\s*(?:bed|matrix)|radical|matrixectomy/i.test(
              attributeText,
            );
        if (def.id === "splint")
          attrs.long_leg = /long.?leg|whole\s+leg|mid.?thigh/i.test(
            attributeText,
          );
        if (["occipital", "pocus", "guidance"].includes(def.id)) {
          attrs.saved_images =
            /images?.{0,30}(?:permanently\s+)?(?:saved|stored|archived)/i.test(
              note,
            );
          attrs.report =
            /interpretive\s+report|interpretation\s*:|impression\s*:/i.test(
              note,
            );
        }
        const pts = timeline.events
          .filter((x) => x.type === "procedure" && !x.ambiguous)
          .sort(
            (x, y) =>
              Math.abs(x.offset - current.start) -
              Math.abs(y.offset - current.start),
          );
        const t =
          pts.find((x) => Math.abs(x.offset - current.start) < 350) || null;
        candidates.push({
          service: def.id,
          label: def.label,
          status,
          actor: a,
          evidence: current.text,
          subjectEvidence: linked ? subject.text : null,
          offset: current.start,
          attrs,
          time: t?.time || null,
          timeEvidence: t?.evidence || null,
          date: t?.date || timeline.date,
          origin: "local",
          performedEvidence: true,
        });
      }
      if (candidates.length) {
        const done = candidates.filter((x) => x.status === "performed");
        const groups = new Set(
          done
            .map((e) => e.attrs.site + "_" + e.attrs.side)
            .filter((x) => !x.includes("undefined")),
        );
        if (groups.size > 1)
          warnings.push(
            def.label +
              ": multiple sites/sides may be present. Local extraction keeps one candidate; use AI or reconcile the distinct procedures before billing.",
          );
        events.push(done.at(-1) || candidates.at(-1));
      }
    }
    // Separate occurrences of different procedure types are not merged. Multiple same-type sites
    // remain a visible review point rather than multiplying fees from repeated template text.
    const fx = events.find(
      (e) => e.service === "fracture_reduction" && e.status === "performed",
    );
    if (fx) {
      events = events.filter((e) => e.service !== "fracture_immobilisation");
    }
    if (events.some((e) => e.service === "occipital"))
      events = events.filter(
        (e) => !(e.service === "nerve_block" && /occipital/i.test(e.evidence)),
      );
    // Explicit roles are authoritative context supplied by the clinician.
    if (context.role && ["primary", "procedure_only"].includes(context.role))
      for (const e of events) if (e.actor === "unknown") e.actor = "self";
    let critical = {
      tier: "none",
      exclusive: false,
      intervals: [],
      evidence: [],
      interventions: [],
      reason: "No qualifying resuscitation established by the local parser.",
    };
    const active = ss.filter((s) => assertion(s.text) === "performed");
    const threat = active.filter(
      (s) =>
        /\b(?:cardiac\s+arrest|pulseless|asystole|respiratory\s+failure|circulatory\s+failure|septic\s+shock|organ\s+failure|life.threatening\s+critical\s+care)\b/i.test(
          s.text,
        ) && !/^\s*(?:no|without)\b/i.test(s.text),
    );
    const rescue = active.filter((s) =>
      /\b(?:CPR\s+(?:performed|continued|initiated)|chest\s+compressions|(?:norepinephrine|epinephrine|adrenaline).{0,35}(?:given|started|infusion|titrated)|(?:started|initiated|titrated).{0,35}(?:norepinephrine|vasopressor|BiPAP)|intubated|defibrillat\w*|emergency\s+reduction)\b/i.test(
        s.text,
      ),
    );
    const otherThreat = active.filter((s) =>
      /\b(?:high\s+probability|probable|imminent|threatened\s+limb|limb.threatening|compensated.{0,50}threat|other\s+critical\s+care)\b/i.test(
        s.text,
      ),
    );
    const gMention = active.some((s) =>
        /\bG(?:395|391|521|523|522)\b/i.test(s.text),
      ),
      critMention =
        gMention ||
        active.some((s) =>
          /critical\s+care|(?:critical\s+)?G[ -]?code|resus(?:citation)?\s+time|fully\s+devoted/i.test(
            s.text,
          ),
        );
    if (threat.length && rescue.length) {
      critical.tier = "life";
      critical.evidence = threat.map((x) => x.text);
      critical.interventions = rescue.map((x) => x.text);
      critical.reason = "Active resuscitation for acute organ failure.";
    } else if (
      otherThreat.length &&
      (rescue.length ||
        /\b(?:transfusion|resuscitat\w*|urgent\s+reduction)\b/i.test(note))
    ) {
      critical.tier = "other";
      critical.evidence = otherThreat.map((x) => x.text);
      critical.interventions = rescue.map((x) => x.text);
      critical.reason = "Resuscitative work for a threatened life or limb.";
    } else if (critMention || threat.length || rescue.length) {
      critical.tier = "uncertain";
      critical.evidence = [...threat, ...otherThreat].map((x) => x.text);
      critical.interventions = rescue.map((x) => x.text);
      critical.reason =
        "Possible critical-care opportunity. Time or acuity wording alone does not establish qualifying resuscitation.";
    }
    critical.exclusive =
      /\b(?:exclusive(?:ly)?|fully\s+devoted)\b|\bno\s+(?:simultaneous|concurrent)\s+(?:patient|care|work)/i.test(
        note,
      );
    if (critMention) {
      let cl = active
        .filter((s) =>
          /\b(?:G395|G391|G521|G523|G522|critical\s+care|(?:critical\s+)?G[ -]?code|resus(?:citation)?\s+time|exclusive)\b/i.test(
            s.text,
          ),
        )
        .map((x) => x.text)
        .join("\n");
      let r = T.ranges(cl, timeline.date, {
        period:
          timeline.time &&
          T.clock(timeline.time, { assume24: true }).minutes < 480
            ? "night"
            : undefined,
      });
      critical.intervals = r.items;
      warnings.push(...r.errors.map((x) => x.message));
    }
    let level = null,
      levelEvidence = "";
    if (
      /\b(?:comprehensive\s+assessment(?:\s+and\s+care)?|full\s+history\s+and\s+(?:full\s+)?examination)\b/i.test(
        note,
      )
    ) {
      level = "comprehensive";
      levelEvidence =
        ss.find((s) =>
          /comprehensive\s+assessment|full\s+history\s+and/i.test(s.text),
        )?.text || "";
    } else if (
      /\b(?:multiple.systems?\s+assessment|detailed\s+history\s+and\s+examination\s+of\s+(?:two|multiple|more\s+than\s+one))\b/i.test(
        note,
      )
    ) {
      level = "multisystem";
      levelEvidence =
        ss.find((s) => /multiple.system|detailed\s+history/i.test(s.text))
          ?.text || "";
    } else if (
      /\b(?:minor\s+assessment|focused\s+assessment|limited\s+assessment|trivial\s+recheck|simple\s+prescription\s+renewal)\b/i.test(
        note,
      )
    ) {
      level = "minor";
      levelEvidence =
        ss.find((s) =>
          /minor\s+assessment|focused\s+assessment|limited\s+assessment|trivial|simple\s+prescription/i.test(
            s.text,
          ),
        )?.text || "";
    }
    let payer =
      context.payer ||
      (/\b(?:WSIB|WCB)\b/.test(note)
        ? "wsib"
        : /\b(?:uninsured|self.pay)\b/i.test(note)
          ? "unknown"
          : "unknown");
    if (/OHIP\s*(?:#|number)?\s*[:=]?\s*(?:None|missing|unknown)/i.test(note))
      payer = "unknown";
    const reassessments = timeline.events
      .filter((e) => e.type === "reassessment" && !e.ambiguous)
      .map((e) => {
        const at = ss.findIndex(
            (s) => e.offset >= s.start && e.offset <= s.end,
          ),
          text = [ss[at]?.text || e.evidence, ss[at + 1]?.text || ""].join(" ");
        return {
          time: e.time,
          date: e.date || timeline.date,
          evidence: e.evidence,
          newOrder:
            /additional|repeat.{0,20}(?:ordered|order)|(?:increase|escalat|another|new dose|bolus)/i.test(
              text,
            ),
          notDisposition:
            /remain.{0,35}(?:ED|department|treatment|observation)|ongoing treatment|not.{0,10}discharg/i.test(
              text,
            ) && !/(?:discharged|admitted|referred) (?:home|to)/i.test(text),
        };
      });
    const ageMatch = note.match(/\b(\d{1,3})\s*(?:[- ]year[- ]old|[FM]\b)/i);
    const f = {
      schema_version: 1,
      inactive: /\bnot\s+active(?:\s+handover)?\b/i.test(note),
      age: ageMatch ? Number(ageMatch[1]) : null,
      date: timeline.date,
      time: timeline.time,
      role,
      reassessments,
      assessment: { level, evidence: levelEvidence },
      events,
      critical,
      payer,
      activation: /activated|backup\s+call|called\s+in\s+for\s+volume/i.test(
        note,
      )
        ? "mentioned"
        : "none",
      timeline,
      warnings,
      origin: "local",
      noteHash: hash(note),
      ms: performance.now() - t0,
    };
    return applyOverrides(f, context);
  }
  function applyOverrides(f, ctx) {
    f = deep(f);
    const o = ctx.overrides || {};
    if (ctx.dateConfirmed && ctx.date) f.date = ctx.date;
    if (ctx.time) f.time = ctx.time;
    if (ctx.role) f.role = ctx.role;
    if (ctx.payer) f.payer = ctx.payer;
    if (o.level) {
      f.assessment.level = o.level;
      f.assessment.evidence = "Clinician-confirmed service descriptor";
      f.assessment.confirmed = true;
    }
    if (o.aCode) f.assessment.aCode = o.aCode;
    if (o.criticalTier) {
      f.critical.tier = o.criticalTier;
      f.critical.confirmed = true;
      f.critical.exclusive = o.exclusive === true;
    }
    if (o.exclusive !== undefined) f.critical.exclusive = o.exclusive === true;
    if (o.intervals) {
      const r = T.ranges(o.intervals, f.date, { assume24: true });
      f.critical.intervals = r.items;
      f.warnings.push(...r.errors.map((x) => x.message));
    }
    for (const e of f.events) {
      const ov = o.events?.[e.service];
      if (ov) {
        if (ov.skipBilling) e.skipBilling = true;
        if (ov.actor) e.actor = ov.actor;
        if (ov.status) e.status = ov.status;
        if (ov.time) e.time = ov.time;
        if (ov.date) e.date = ov.date;
        Object.assign(e.attrs, ov.attrs || {});
        e.confirmed = true;
      }
    }
    if (ctx.procedureTime)
      for (const e of f.events)
        if (e.status === "performed") e.time = ctx.procedureTime;
    return f;
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    let v = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      let w = [i + 1];
      for (let j = 0; j < b.length; j++)
        w[j + 1] = Math.min(
          w[j] + 1,
          v[j + 1] + 1,
          v[j] + (a[i] === b[j] ? 0 : 1),
        );
      v = w;
    }
    return v[b.length];
  }
  function semanticSearch(query, data, limit = 8) {
    const q = norm(query),
      qt = q.split(" ").filter((x) => x.length > 2),
      ranked = [],
      linked = new Map();
    for (const s of data.services) {
      let score = 0,
        why = [];
      for (const a0 of [s.label, ...s.aliases]) {
        const a = norm(a0);
        if (q === a) {
          score = Math.max(score, 50);
          why = [a0];
        } else if (q.includes(a) && a.length > 2) {
          score = Math.max(score, 32 + a.split(" ").length);
          why.push(a0);
        } else {
          const at = a.split(" ");
          let hits = qt.filter((t) => at.includes(t)).length;
          if (hits)
            score = Math.max(score, hits * 5 + (hits === at.length ? 7 : 0));
          for (const t of qt)
            if (
              t.length >= 5 &&
              at.some((z) => z.length >= 5 && editDistance(t, z) <= 1)
            )
              score = Math.max(score, 9);
        }
      }
      if (score) {
        ranked.push({
          kind: "service",
          id: s.id,
          title: s.label,
          score,
          why: unique(why),
          codes: s.codes,
          rule_ids: s.rule_ids,
          fields: s.fields,
          bundles: s.bundles,
        });
        for (const r of s.rule_ids)
          linked.set(r, Math.max(linked.get(r) || 0, score * 0.7));
      }
    }
    for (const c of data.codes) {
      const cq = c.code.toLowerCase();
      let score = q === cq ? 90 : qt.includes(cq) ? 65 : 0;
      if (score) {
        ranked.push({
          kind: "code",
          id: c.code,
          title: c.code + " · " + c.label,
          score,
          codes: [c.code],
          rule_ids: c.rule_ids,
        });
        for (const r of c.rule_ids) linked.set(r, 75);
      }
    }
    for (const r of V.retrieve(query, data, 12))
      ranked.push({
        kind: "rule",
        id: r.id,
        title: r.title,
        score: r.score + (linked.get(r.id) || 0),
        body: r.body,
        status: r.review_status,
        source_ids: r.source_ids,
        codes: [],
      });
    for (const [id, score] of linked)
      if (!ranked.some((x) => x.id === id)) {
        const r = data.rules.find((x) => x.id === id);
        if (r)
          ranked.push({
            kind: "rule",
            id,
            title: r.title,
            score,
            body: r.body,
            status: r.review_status,
            source_ids: r.source_ids,
            codes: [],
          });
      }
    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function relevantRules(f, data, limit = 9) {
    let ids = new Set(["R001", "R002", "R004", "R045"]);
    if (f.critical.tier !== "none")
      for (const x of ["R010", "R011", "R012", "R013", "R005"]) ids.add(x);
    if (f.activation === "mentioned")
      for (const x of ["R006", "R007", "R008"]) ids.add(x);
    for (const e of f.events) {
      const d = data.services.find((x) => x.id === e.service);
      for (const x of d?.rule_ids || []) ids.add(x);
    }
    return [...ids]
      .map((id) => data.rules.find((r) => r.id === id))
      .filter(Boolean)
      .slice(0, limit);
  }
  function question(id, text, field, options = [], extra = {}) {
    return { id, text, field, options, priority: 60, ...extra };
  }
  function pickProcedure(e, data, ctx) {
    const a = e.attrs || {},
      s = e.service;
    let code = null,
      questions = [],
      warnings = [],
      excluded = [];
    const q = (field, text, options = []) =>
      questions.push(
        question(
          s + "_" + field,
          text,
          "events." + s + ".attrs." + field,
          options,
        ),
      );
    if (s === "laceration") {
      if (a.length_cm == null)
        q("length_cm", "What was the total repaired wound length in cm?");
      if (!a.site)
        q("site", "Where was the repaired laceration?", [
          "face",
          "hand",
          "leg",
          "trunk",
        ]);
      if (a.length_cm > 0 && a.site) {
        const face = a.site === "face",
          n = a.length_cm;
        code = face
          ? n <= 5
            ? "Z154"
            : n <= 10
              ? "Z177"
              : n <= 15
                ? "Z190"
                : "Z192"
          : n <= 5
            ? "Z176"
            : n <= 10
              ? "Z175"
              : n <= 15
                ? "Z179"
                : "Z191";
        if (a.complex === true)
          warnings.push(
            "Complex repair selected: verify anatomy, actual repair complexity and required time; simple closure code retained until reviewed.",
          );
      }
    } else if (s === "abscess") {
      if (a.site === "perianal") code = "Z104";
      else if (a.anaesthesia === "general") code = "Z102";
      else if (a.anaesthesia === "sedation")
        q(
          "anaesthesia",
          "Was general anaesthesia used, or local anaesthesia with sedation?",
          ["local", "general"],
        );
      else code = a.count >= 3 ? "Z174" : a.count === 2 ? "Z173" : "Z101";
    } else if (s === "nail_excision") code = a.radical ? "Z130" : "Z128";
    else if (s === "fracture_reduction") {
      const map = {
        distal_radius: "F028",
        forearm: "F032",
        finger: "F005",
        metacarpal: "F009",
        bennett: "F013",
        olecranon: "F035",
        humeral_shaft: "F043",
        humeral_neck: "F054",
        toe: "F058",
        metatarsal: "F063",
        calcaneus: "F071",
        ankle: "F075",
        tibia: "F079",
        nose: "F136",
      };
      if (!a.site || !map[a.site])
        q("site", "Which fracture did you reduce?", Object.keys(map));
      else if (a.site === "distal_radius") {
        if (["none", "local"].includes(a.anaesthesia)) code = "F028";
        else if (a.anaesthesia === "general") code = "F046";
        else if (a.anaesthesia === "sedation") {
          code = "F046";
          warnings.push(
            "F046: verify the documented anaesthetic service meets the applicable reduction descriptor; sedation is not universally interchangeable with general anaesthesia.",
          );
        } else
          q(
            "anaesthesia",
            "What anaesthetic method was used for the reduction?",
            ["local", "sedation", "general", "none"],
          );
      } else code = map[a.site];
    } else if (s === "dislocation") {
      const map = {
        finger: "D001",
        elbow: "D009",
        radial_head: "D012",
        toe: "D030",
        ankle: "D035",
        knee: "D038",
        hip: "D042",
      };
      if (a.site === "shoulder" || a.site === "patella") {
        if (a.anaesthesia === "unknown" || !a.anaesthesia)
          q("anaesthesia", "Which reduction anaesthetic variant applies?", [
            "none",
            "local",
            "sedation",
            "general",
          ]);
        else
          code =
            a.site === "shoulder"
              ? a.anaesthesia === "none"
                ? "D015"
                : "D016"
              : a.anaesthesia === "none"
                ? "D040"
                : "D031";
      } else if (map[a.site]) code = map[a.site];
      else
        q("site", "Which joint was reduced?", [
          "shoulder",
          "finger",
          "elbow",
          "radial_head",
          "patella",
          "ankle",
          "hip",
        ]);
    } else if (s === "fracture_immobilisation") code = "F062";
    else if (s === "splint") {
      if (!a.site)
        q("site", "Where was the cast or backslab applied?", [
          "finger",
          "hand",
          "forearm",
          "leg",
          "ankle",
        ]);
      else
        code =
          a.site === "finger"
            ? "Z201"
            : a.site === "hand"
              ? "Z202"
              : ["elbow", "forearm", "arm", "distal_radius"].includes(a.site)
                ? "Z203"
                : a.long_leg
                  ? "Z211"
                  : "Z213";
    } else if (s === "paracentesis" || s === "thoracentesis") {
      if (!["therapeutic", "diagnostic"].includes(a.purpose))
        q("purpose", "Was the drainage diagnostic or therapeutic?", [
          "diagnostic",
          "therapeutic",
        ]);
      else
        code =
          s === "paracentesis"
            ? a.purpose === "diagnostic"
              ? "Z590"
              : "Z591"
            : a.purpose === "diagnostic"
              ? "Z331"
              : "Z332";
    } else if (s === "occipital") {
      code = "G264";
      warnings.push(
        "G264: verify same-day and annual limits. G264 is not on the reviewed E412/E413 eligible list.",
      );
      if (a.side === "bilateral")
        warnings.push(
          "An additional eligible unilateral block may support G265; verify side/service and prior block limits.",
        );
    } else if (s === "nerve_block") {
      if (!a.exact_code)
        q("exact_code", "Which specific nerve-block listing applies?", [
          "G060",
          "G061",
          "G231",
          "G224",
        ]);
      else if (!a.preamble_confirmed)
        q(
          "preamble_confirmed",
          "Have you verified all current " +
            a.exact_code +
            " requirements, including the applicable pain-management preamble?",
          ["yes", "no"],
        );
      if (a.exact_code && a.preamble_confirmed) {
        code = a.exact_code;
        questions = [];
      }
    } else if (s === "pocus") {
      const eligible =
        /(tamponade|cardiac\s+standstill|trauma.{0,50}ha?emorrhage|ruptured\s+(?:AAA|abdominal\s+aortic|ectopic))/i.test(
          a.indication || e.evidence,
        );
      if (!eligible)
        q("indication", "Which eligible H100 indication was investigated?", [
          "tamponade",
          "cardiac standstill",
          "traumatic intraperitoneal hemorrhage",
          "ruptured AAA",
          "ruptured ectopic pregnancy",
        ]);
      if (!a.saved_images || !a.report)
        q(
          "documentation",
          "Were permanent images saved AND an interpretive report completed?",
          ["yes", "no"],
        );
      if (eligible && a.saved_images && a.report) code = "H100";
    } else if (s === "guidance") {
      q(
        "preamble",
        "Verify J149C guidance/reporting requirements, not just site marking.",
        ["verified", "not_met"],
      );
      if (a.preamble === "verified") {
        code = "J149C";
        questions = [];
      }
    } else if (s === "iv") {
      const age = ctx.age;
      if (age != null && age < 18) {
        warnings.push(
          "Adult IV listing cannot be applied automatically to a child.",
        );
      } else code = "G379";
    } else if (s === "form1") code = "K623";
    else if (s === "mto") {
      if (a.mandatory === true) code = "K035";
      else
        q(
          "mandatory",
          "Was this the qualifying mandatory medical-condition report?",
          ["yes", "no"],
        );
    } else if (s === "homecare") {
      if (a.new_application === true && a.complete === true) code = "K070";
      else
        q(
          "new_application",
          "Did you complete the whole application for a NEW home-care admission?",
          ["yes", "no"],
        );
    } else if (s === "telephone" || s === "criticall" || s === "econsult") {
      if (a.eligibility_confirmed === true)
        code = s === "telephone" ? "K734" : s === "criticall" ? "K736" : "K738";
      else
        q(
          "eligibility_confirmed",
          s === "telephone"
            ? "Does the documented call meet K734 duration, advice and no-immediate-attendance requirements?"
            : s === "criticall"
              ? "Was this an eligible CritiCall-arranged clinical consultation, with participants and advice documented?"
              : "Was this an eligible secure e-consult rather than arranging transfer or in-person care?",
          ["yes", "no"],
        );
    } else if (s === "pronouncement") {
      if (a.pronounced_by === "other" && a.certificate_completed) code = "A771";
      else if (a.pronounced_by === "self") code = "A777";
      else
        q(
          "pronounced_by",
          "Did you pronounce the patient, or only complete a certificate after another physician?",
          ["self", "other"],
        );
    } else if (s === "bereavement") {
      q(
        "eligibility_confirmed",
        "K015 has purpose and duration requirements; ordinary death notification is not automatically a separate counselling service.",
        ["yes", "no"],
      );
      if (a.eligibility_confirmed && a.minutes > 15) {
        code = "K015";
        questions = [];
      }
    } else if (s === "admission_orders") {
      if (a.separate_mrp === true) code = "H105";
      else
        q(
          "separate_mrp",
          "Did you write qualifying interim inpatient orders pending admission by a different MRP?",
          ["yes", "no"],
        );
    } else if (
      ["pelvic", "cast_removal", "ng_lavage", "joint_aspiration"].includes(s)
    ) {
      const d = data.services.find((x) => x.id === s);
      if (!a.exact_code)
        q(
          "exact_code",
          "Confirm the exact current listing for " + d.label + ".",
          d.codes,
        );
      else if (!a.preamble_confirmed)
        q(
          "preamble_confirmed",
          "Have the current " +
            a.exact_code +
            " preamble and exclusions been checked for this service?",
          ["yes", "no"],
        );
      if (a.exact_code && a.preamble_confirmed) {
        code = a.exact_code;
        questions = [];
      }
    } else {
      const direct = {
        chest_tube: "Z341",
        chest_tube_removal: "Z363",
        lumbar_puncture: "Z804",
        foley: "Z611",
        disimpaction: "Z756",
        hernia_reduction: "Z538",
        cardioversion: "Z437",
        transvenous_pacing: "Z443",
        intubation: "G211",
        central_line: "G269",
        arterial_line: "G268",
        io: "G270",
        abg: "Z459",
      };
      code = direct[s] || null;
      if (!code) {
        const d = data.services.find((x) => x.id === s);
        q(
          "exact_code",
          "Service recognized: " +
            (d?.label || s) +
            ". Its current code is not in an automatic mapping; retrieve the exact listing.",
        );
      }
    }
    return { code, questions, warnings, excluded };
  }
  function compile(f, context, data, ledger = []) {
    const start = performance.now(),
      items = [],
      questions = [],
      warnings = [...f.warnings],
      excluded = [],
      opportunities = [],
      proofs = [],
      ctx = context || {},
      o = ctx.overrides || {};
    let level = o.level || f.assessment.level,
      crit = false,
      period = null;
    const add = (code, reason, evidence = "", units = 1, rule_ids = []) => {
      if (!code) return;
      if (!data.codes.some((c) => c.code === code)) {
        warnings.push(
          "Unknown code " + code + " held for current-source review",
        );
        return;
      }
      const old = items.find((x) => x.code === code);
      if (old) {
        old.units = Math.max(old.units, units);
        return;
      }
      items.push({
        code,
        units,
        reason,
        evidence,
        rule_ids: rule_ids.length
          ? rule_ids
          : data.codes.find((c) => c.code === code)?.rule_ids || [],
        status: "draft",
      });
    };
    for (const i of f.timeline?.issues || []) {
      if (
        (i.field === "time" && ctx.time) ||
        (i.field === "date" && ctx.dateConfirmed)
      )
        continue;
      questions.push(
        question(i.id, i.message, i.field, i.options, { priority: 100 }),
      );
    }
    const timing =
      !!f.date &&
      !!f.time &&
      !questions.some((q) => q.field === "time" || q.field === "date");
    if (f.role === "assistant") {
      excluded.push(
        "Assistance alone does not support a second full operator claim or an other-service premium.",
      );
    }
    const intervals = T.totalExclusive(f.critical.intervals || []);
    if (["other", "life"].includes(f.critical.tier)) {
      if (!f.critical.intervals.length)
        questions.push(
          question(
            "critical_time",
            "What were the actual exclusive critical-care start/stop intervals?",
            "intervals",
            [],
            { priority: 95 },
          ),
        );
      if (!f.critical.exclusive)
        questions.push(
          question(
            "exclusive",
            "Were these minutes fully devoted to this patient, excluding separately billed procedures and other patients?",
            "exclusive",
            ["yes", "no"],
            { priority: 95 },
          ),
        );
      if (intervals.overlaps.length)
        warnings.push(
          "Overlapping critical-care intervals within this case: correct the time record.",
        );
      if (intervals.crossesMidnight)
        warnings.push(
          "Critical care crosses a calendar date: review per-day claim allocation before export.",
        );
      crit =
        timing &&
        f.critical.intervals.length > 0 &&
        f.critical.exclusive &&
        !intervals.overlaps.length &&
        !intervals.crossesMidnight &&
        f.role !== "assistant";
      if (crit) {
        const base = V.criticalUnits(intervals.total, f.critical.tier);
        for (const x of base)
          add(
            x.code,
            `${intervals.total} ${f.critical.timeBasis === "estimated" ? "proposed" : "documented"} care minutes; aggregate before rounding`,
            f.critical.evidence.join(" | "),
            x.units,
            ["R010", "R011", "R012"],
          );
        add(
          V.otherPremium(
            f.date,
            f.critical.intervals[0]?.start || f.time,
            ctx.holiday,
          ),
          "Other-service premium matched to the start of critical care",
          "",
          1,
          ["R005"],
        );
        if (intervals.total > 120)
          warnings.push(
            "Over two hours: reviewed Schedule directs manual submission; verify current process.",
          );
      }
    } else if (f.critical.tier === "uncertain")
      opportunities.push({
        id: "critical",
        title: "Critical-care candidate needs clinical evidence",
        detail: f.critical.reason,
        question: question(
          "critical_tier",
          "Which threshold did the actual resuscitation meet? Do not select a tier just because time is documented.",
          "criticalTier",
          ["none", "other", "life"],
          { priority: 90 },
        ),
        rule_ids: ["R010", "R011"],
      });
    const form = f.events.find(
      (e) =>
        e.service === "form1" && e.status === "performed" && e.actor === "self",
    );
    const death = f.events.find(
      (e) =>
        e.service === "pronouncement" &&
        e.status === "performed" &&
        e.actor === "self",
    );
    const special = ctx.pathway === "svp" || f.activation === "mentioned";
    if (!crit && f.role !== "assistant") {
      if (form) {
        add(
          "K623",
          "Completed Form 1 service includes its assessment",
          form.evidence,
        );
        if (timing)
          add(
            V.otherPremium(f.date, f.time, ctx.holiday),
            "Eligible premium-hours other service",
            form.evidence,
          );
      } else if (["procedure_only", "sedation"].includes(f.role)) {
        // Premium is added only after another actual candidate service exists.
      } else if (timing) {
        if (!level)
          questions.push(
            question(
              "assessment_descriptor",
              "Which assessment descriptor was actually completed? H1x2 and H1x3 are not an ascending severity ladder.",
              "level",
              ["minor", "multisystem", "comprehensive"],
              { priority: 70 },
            ),
          );
        if (special) {
          if (!ctx.activationConfirmed)
            questions.push(
              question(
                "activation",
                "Was this an eligible requested attendance from outside the hospital, with travel and request details recorded?",
                "activationConfirmed",
                ["yes", "no"],
                { priority: 85 },
              ),
            );
          if (ctx.activationConfirmed) {
            const prior =
              ctx.svpPrior != null
                ? +ctx.svpPrior
                : ledger.filter(
                    (r) =>
                      r.periodKey ===
                        V.svpPeriod(f.date, f.time, ctx.holiday).key &&
                      !r.excluded &&
                      r.specialVisit === true,
                  ).length;
            period = V.svpChoice(f.date, f.time, prior, ctx.holiday);
            if (period.patientCode) {
              const ac = o.aCode || f.assessment.aCode;
              if (!ac)
                questions.push(
                  question(
                    "a_descriptor",
                    "Which A-prefix assessment requirements are met?",
                    "aCode",
                    ["A001", "A007", "A003"],
                    { priority: 75 },
                  ),
                );
              else add(ac, "Activated-visit assessment", f.assessment.evidence);
              if (ac)
                add(
                  period.patientCode,
                  `Patient ${prior + 1} in ${period.period} special-visit period`,
                  "",
                  1,
                  ["R007"],
                );
              if (ctx.newTrip) {
                if (!ctx.tripId)
                  questions.push(
                    question(
                      "trip_id",
                      "Identify the actual trip before adding travel.",
                      "tripId",
                      [],
                      { priority: 70 },
                    ),
                  );
                else if (
                  ledger.some((r) => r.tripId === ctx.tripId && r.travelClaimed)
                )
                  excluded.push("Travel already billed on this physical trip.");
                else if (
                  period.tripCap !== null &&
                  ledger.filter(
                    (r) => r.periodKey === period.key && r.travelClaimed,
                  ).length >= period.tripCap
                )
                  excluded.push("Travel-period maximum already used.");
                else if (ac)
                  add(
                    period.travel,
                    "Separate actual requested journey",
                    ctx.tripId,
                  );
              }
            } else {
              if (level)
                add(
                  V.assessment(f.date, f.time, level, ctx.holiday),
                  "Special-visit cap exhausted: ordinary ED assessment",
                  f.assessment.evidence,
                );
              warnings.push("Special-visit patient cap exhausted.");
            }
          }
        } else if (level)
          add(
            V.assessment(f.date, f.time, level, ctx.holiday),
            "Assessment matched to physician time and selected descriptor",
            f.assessment.evidence,
          );
      }
    }
    const done = f.events.filter((e) => e.status === "performed");
    const bundled = new Set();
    for (const e of done)
      if (
        e.actor === "self" &&
        !e.skipBilling &&
        pickProcedure(e, data, ctx).code
      )
        for (const b of data.services.find((s) => s.id === e.service)
          ?.bundles || [])
          bundled.add(b);
    let procedureBases = [],
      separatelyTimed = [];
    for (const e of f.events) {
      if (e.skipBilling) {
        excluded.push(
          e.label +
            ": omitted from claim by clinician; clinical event retained.",
        );
        continue;
      }
      if (e.status !== "performed") {
        excluded.push(
          e.label + ": " + e.status + " — not a performed service.",
        );
        continue;
      }
      if (
        crit &&
        [
          "iv",
          "foley",
          "central_line",
          "arterial_line",
          "intubation",
          "abg",
          "ng_lavage",
        ].includes(e.service)
      ) {
        excluded.push(e.label + ": included in this critical-care pathway.");
        continue;
      }
      if (
        (e.actor === "nurse" || e.actor === "other") &&
        !(
          f.role === "sedation" &&
          ["fracture_reduction", "dislocation", "cardioversion"].includes(
            e.service,
          )
        )
      ) {
        excluded.push(
          e.label +
            ": performed by " +
            (e.actor === "nurse"
              ? "nursing/another non-billing team member"
              : "another physician") +
            ".",
        );
        continue;
      }
      if (bundled.has(e.service)) {
        excluded.push(
          e.label +
            ": included in the selected fracture/procedure work; no duplicate cast/block claim.",
        );
        continue;
      }
      if (e.actor === "unknown" && f.role !== "sedation") {
        questions.push(
          question(
            e.service + "_actor",
            "Did you personally perform " + e.label.toLowerCase() + "?",
            "events." + e.service + ".actor",
            ["self", "other", "nurse"],
            { priority: 80 },
          ),
        );
        continue;
      }
      if (f.role === "assistant") {
        excluded.push(e.label + ": role is assistant, not primary operator.");
        continue;
      }
      if (crit && f.critical.tier === "life" && e.service === "cardioversion") {
        excluded.push(
          "Cardioversion included in life-threatening critical care.",
        );
        continue;
      }
      if (crit && e.service === "pronouncement") {
        excluded.push(
          "Do not duplicate the included assessment with a pronouncement assessment; certificate roles require separate descriptor review.",
        );
        continue;
      }
      if (f.role === "sedation") {
        if (
          !["fracture_reduction", "dislocation", "cardioversion"].includes(
            e.service,
          )
        )
          continue;
        const pick = pickProcedure(e, data, ctx);
        questions.push(...pick.questions);
        warnings.push(...pick.warnings);
        if (pick.code) {
          const cc = pick.code + "C";
          const ranges = T.ranges(
            o.sedationIntervals || ctx.note || "",
            f.date,
            { assume24: !!o.sedationIntervals },
          );
          const known = data.codes.find((c) => c.code === cc);
          if (!known) {
            questions.push(
              question(
                "sedation_code",
                "Confirm the C-suffix anaesthesia listing for " +
                  pick.code +
                  ".",
                "sedationCode",
              ),
            );
            continue;
          }
          if (!ranges.items.length)
            questions.push(
              question(
                "sedation_time",
                "Enter actual continuous sedation start–end times, with AM/PM.",
                "sedationIntervals",
              ),
            );
          else {
            add(
              cc,
              `${V.anaesthesiaUnits(ranges.total)} weighted time units; base and modifiers still require review`,
              ranges.items.map((x) => x.evidence).join("; "),
            );
            items.at(-1).timeUnits = V.anaesthesiaUnits(ranges.total);
            items.at(-1).anaesthesiaWorksheet = true;
            const p = V.sedationPremium(
              ranges.items[0].date,
              ranges.items[0].start,
              ctx.holiday,
            );
            add(p, "Anaesthesia premium follows case commencement");
            if (timing)
              add(
                V.otherPremium(
                  ranges.items[0].date,
                  ranges.items[0].start,
                  ctx.holiday,
                ),
                "Sedation-only other-service premium",
              );
            warnings.push(
              "Anaesthesia worksheet only: verify base units, ASA/age/BMI modifiers and submission unit convention before billing.",
            );
          }
        }
        continue;
      }
      const p = pickProcedure(e, data, { ...ctx, age: ctx.age ?? f.age });
      questions.push(...p.questions);
      warnings.push(...p.warnings);
      excluded.push(...p.excluded);
      if (p.code) {
        add(
          p.code,
          e.label,
          e.evidence,
          1,
          data.services.find((x) => x.id === e.service)?.rule_ids,
        );
        const c = data.codes.find((x) => x.code === p.code);
        const eligible = [
          "candidate_surgical_check_preamble",
          "listed_historical_GP104",
        ].includes(c?.premium_eligibility);
        if (eligible) {
          if (!e.time)
            opportunities.push({
              id: e.service + "_premium",
              title: "Check the after-hours procedure premium",
              detail: `${p.code}: procedure commencement time is missing. Do not use note-signing or arrival time.`,
              question: question(
                e.service + "_time",
                "When did " + e.label.toLowerCase() + " commence?",
                "events." + e.service + ".time",
                [],
                { priority: 65 },
              ),
              rule_ids: ["R020"],
            });
          else if (special && period?.patientCode)
            excluded.push(
              "E412/E413: not automatically payable with the A-prefix special-visit claim.",
            );
          else if (e.date || f.date) {
            let pp = V.procedurePremium(e.date || f.date, e.time, ctx.holiday);
            if (pp)
              procedureBases.push({
                premium: pp,
                base: p.code,
                time: e.time,
                date: e.date || f.date,
              });
          }
        }
        if (crit) {
          separatelyTimed.push(e);
          warnings.push(
            `${p.code}: exclude its separately billable procedure time from critical-care intervals.`,
          );
        }
      }
    }
    for (const p of procedureBases) {
      add(
        p.premium,
        "Eligible non-elective procedure time band; verify current preamble",
        `${p.base} commenced ${p.date} ${p.time}`,
        1,
        ["R020"],
      );
      const x = items.find((i) => i.code === p.premium);
      x.baseCodes = unique([...(x.baseCodes || []), p.base]);
    }
    if (
      ["procedure_only", "sedation"].includes(f.role) &&
      timing &&
      items.some((i) => !/^H11[234]$/.test(i.code))
    )
      add(
        V.otherPremium(f.date, f.time, ctx.holiday),
        "Another service rendered; no separate ED assessment",
      );
    // Bundled clinical care need not be called an additional procedure by the model to capture a premium.
    if (criticalPossible(f) && f.critical.tier === "none")
      opportunities.push({
        id: "critical_scan",
        title: "Review whether active care crossed a critical-care threshold",
        detail:
          "The note describes potentially serious treatment. A diagnosis or minutes alone is not enough.",
        rule_ids: ["R010"],
      });
    if (
      /\b(?:at work|work.related|workplace)\b/i.test(ctx.note || "") &&
      f.payer !== "wsib"
    )
      opportunities.push({
        id: "payer",
        title: "Possible WSIB pathway",
        detail:
          "Confirm payer and initial reporting requirements; a missing OHIP number is not proof of no coverage.",
        question: question(
          "payer",
          "Was this a workplace-insured encounter?",
          "payer",
          ["wsib", "ohip", "unknown"],
        ),
        rule_ids: ["R034", "R035"],
      });
    if (f.payer === "wsib")
      opportunities.push({
        id: "form8",
        title: "Do not miss the initial WSIB report",
        detail:
          "Clinical-service routing and Form 8 reporting are separate. Verify current report submission and fee rules.",
        rule_ids: ["R035"],
      });
    if (!crit && (ctx.reassessments || f.reassessments?.length)) {
      let lastAssessment = V.stamp(f.date, f.time),
        reassessmentCount = 0;
      for (const r of [...(ctx.reassessments || f.reassessments)].sort(
        (a, b) =>
          V.stamp(a.date || f.date, a.time) - V.stamp(b.date || f.date, b.time),
      )) {
        if (!r.time || !f.time || !f.date) continue;
        const ra = V.stamp(r.date || f.date, r.time),
          last = r.lastTime
            ? V.stamp(r.lastDate || f.date, r.lastTime)
            : lastAssessment;
        if (
          ra - last >= 120 &&
          r.newOrder &&
          r.notDisposition &&
          reassessmentCount < 2
        ) {
          reassessmentCount++;
          lastAssessment = ra;
          add(
            V.assessment(r.date || f.date, r.time, "reassessment", ctx.holiday),
            r.reason || "Substantive reassessment with further care",
            r.evidence || "Clinician-confirmed",
          );
        } else
          excluded.push(
            "Reassessment does not meet confirmed elapsed-time/new-care/non-disposition requirements.",
          );
      }
    }
    const validation = V.validateCodes(items, data, {
      role: f.role === "sedation" ? "sedation" : undefined,
      ecgAllowed: ctx.ecgAllowed || false,
    });
    warnings.push(...validation.warnings);
    let blockers = validation.errors.filter(
      (e) => !e.includes("Anaesthesia percentage premium lacks"),
    );
    const abs = f.critical.intervals.map(T.absolute).filter(Boolean);
    if (crit && ctx.encounterId) {
      const overlaps = V.overlaps([
        ...ledger
          .filter((x) => x.encounterId !== ctx.encounterId)
          .map((x) => ({
            encounterId: x.encounterId,
            criticalIntervals: x.criticalIntervals || [],
            excluded: x.excluded,
          })),
        { encounterId: ctx.encounterId, criticalIntervals: abs },
      ]);
      for (const x of overlaps)
        if (x.a === ctx.encounterId || x.b === ctx.encounterId)
          blockers.push(
            `Exclusive critical care overlaps ${x.a === ctx.encounterId ? x.b : x.a} by ${x.minutes} minutes.`,
          );
    }
    for (const u of f.uncaptured_work || [])
      opportunities.push({
        id: "unmapped_" + opportunities.length,
        title: u.description,
        detail: u.reason + " Evidence: " + u.evidence,
        rule_ids: ["R047"],
      });
    // A missing ordinary descriptor should not hold a fully-supported critical-care pathway.
    let qq = questions.filter(
      (q) => !crit || !["assessment_descriptor", "a_descriptor"].includes(q.id),
    );
    if (special && period?.patientCode)
      qq = qq.filter((q) => q.id !== "assessment_descriptor");
    qq = [...new Map(qq.map((q) => [q.id, q])).values()].sort(
      (a, b) => b.priority - a.priority,
    );
    if (f.inactive) {
      items.length = 0;
      qq = [];
      opportunities.length = 0;
      crit = false;
      excluded.push(
        "Explicit NOT ACTIVE marker: excluded from this physician’s shift reconstruction. Review the encounter separately if that marker is wrong.",
      );
    }
    return {
      items,
      line: V.line(items),
      questions: qq,
      opportunities,
      excluded: unique(excluded),
      warnings: unique(warnings),
      blockers,
      critical: crit,
      criticalTimeBasis: crit ? f.critical.timeBasis || "documented" : null,
      criticalProposed: crit && !!f.critical.proposed,
      criticalMinutes: crit ? intervals.total : null,
      criticalIntervals: crit ? abs : [],
      period,
      proofs,
      ms: performance.now() - start,
      requiresReview: true,
      fullyVerified: false,
    };
  }
  function criticalPossible(f) {
    return f.events.some(
      (e) =>
        ["intubation", "transvenous_pacing"].includes(e.service) &&
        e.status === "performed",
    );
  }
  function validateExtraction(obj, note, data) {
    let errors = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
      return ["Expected a fact object"];
    if (obj.schema_version !== 1) errors.push("Unsupported extraction schema");
    if (!Array.isArray(obj.events)) errors.push("events must be an array");
    if (obj.events?.length > 50)
      errors.push("Too many events for one encounter");
    if (
      ![
        "primary",
        "procedure_only",
        "sedation",
        "assistant",
        "handover",
      ].includes(obj.role)
    )
      errors.push("Invalid physician role");
    if (obj.date != null && !T.parseDate(obj.date))
      errors.push("Invalid service date");
    if (obj.time != null && !T.clock(obj.time, { assume24: true }))
      errors.push("Invalid time");
    for (const e of obj.events || []) {
      if (!data.services.some((s) => s.id === e.service))
        errors.push("Unknown service " + e.service);
      if (
        !["performed", "planned", "refused", "historical", "negated"].includes(
          e.status,
        )
      )
        errors.push("Invalid event status");
      if (!["self", "other", "nurse", "unknown"].includes(e.actor))
        errors.push("Invalid event actor");
      if (!proof(note, e.evidence))
        errors.push("Evidence not found for " + e.service);
      if (!e.attrs || typeof e.attrs !== "object" || Array.isArray(e.attrs))
        errors.push("Missing event attributes");
      if (
        e.attrs?.eligibility_confirmed ||
        e.attrs?.preamble_confirmed ||
        e.attrs?.exact_code
      )
        errors.push("Model may not authorize a payment preamble");
      if (e.time && !proof(note, e.time_evidence))
        errors.push("Procedure time evidence required");
      if (
        e.time &&
        e.time_evidence &&
        !T.tokens(e.time_evidence, { assume24: true }).some(
          (t) => t.time === e.time,
        )
      )
        errors.push("Procedure time differs from its quote");
      if (
        e.attrs?.length_cm != null &&
        (!Number.isFinite(e.attrs.length_cm) ||
          e.attrs.length_cm <= 0 ||
          e.attrs.length_cm > 200)
      )
        errors.push("Invalid wound length");
      if (e.time != null && !T.clock(e.time, { assume24: true }))
        errors.push("Invalid procedure time");
    }
    if (
      !obj.assessment ||
      !["minor", "comprehensive", "multisystem", null].includes(
        obj.assessment.level,
      )
    )
      errors.push("Invalid assessment descriptor");
    if (obj.assessment?.level && !obj.assessment?.evidence)
      errors.push("Assessment requires evidence");
    if (obj.assessment?.evidence && !proof(note, obj.assessment.evidence))
      errors.push("Assessment evidence not found");
    for (const k of ["date_evidence", "time_evidence", "role_evidence"])
      if (obj[k] && !proof(note, obj[k])) errors.push(k + " not found");
    if (obj.time && !obj.time_evidence)
      errors.push("Time evidence is required");
    if (
      obj.time &&
      obj.time_evidence &&
      !T.tokens(obj.time_evidence, { assume24: true }).some(
        (t) => t.time === obj.time,
      )
    )
      errors.push("Assessment time differs from quote");
    if (obj.date && !obj.date_evidence)
      errors.push("Date evidence is required");
    for (const u of obj.uncaptured_work || [])
      if (!proof(note, u.evidence))
        errors.push("Uncaptured-work evidence not found");
    for (const r of obj.reassessments || [])
      if (!proof(note, r.evidence))
        errors.push("Reassessment evidence not found");
    if (
      !obj.critical ||
      !["none", "uncertain", "other", "life"].includes(obj.critical.tier)
    )
      errors.push("Invalid critical-care tier");
    for (const s of [
      ...(obj.critical?.evidence || []),
      ...(obj.critical?.interventions || []),
    ])
      if (!proof(note, s)) errors.push("Critical-care evidence not found");
    for (const r of obj.critical?.intervals || []) {
      if (!proof(note, r.evidence)) errors.push("Interval evidence not found");
      if (
        !T.clock(r.start, { assume24: true }) ||
        !T.clock(r.end, { assume24: true })
      )
        errors.push("Invalid interval clock");
      else if (
        !T.ranges(r.evidence, r.date || obj.date, {
          assume24: true,
        }).items.some((x) => x.start === r.start && x.end === r.end)
      )
        errors.push("Critical interval differs from its quote");
    }
    if (
      ["other", "life"].includes(obj.critical?.tier) &&
      (!(obj.critical.evidence || []).length ||
        !(obj.critical.interventions || []).length)
    )
      errors.push(
        "Critical-care threshold and intervention evidence are required",
      );
    return unique(errors);
  }
  function mergeModel(local, obj, note, context, data) {
    const errors = validateExtraction(obj, note, data);
    if (errors.length) return { ok: false, errors, facts: local };
    let f = deep(obj);
    f.timeline = local.timeline;
    f.warnings = [...local.warnings, ...(obj.warnings || [])];
    f.age = local.age;
    f.inactive = local.inactive;
    f.origin = "model";
    f.activation = obj.activation || local.activation;
    f.payer = obj.payer || local.payer;
    f.noteHash = hash(note);
    if (f.date && local.date && f.date !== local.date && !context.dateConfirmed)
      f.timeline.issues.push({
        id: "model_date_conflict",
        field: "date",
        message: "Model and literal PIA disagree on service date.",
        options: [local.date, f.date],
      });
    if (f.time && local.time && f.time !== local.time && !context.time)
      f.timeline.issues.push({
        id: "model_time_conflict",
        field: "time",
        message: "Model and literal PIA disagree on physician time.",
        options: [local.time, f.time],
      });
    f.events = f.events.map((e) => ({
      ...e,
      label: data.services.find((s) => s.id === e.service)?.label || e.service,
      date: e.date || f.date,
      origin: "model",
      proof: proof(note, e.evidence),
    }));
    f.critical.intervals = (f.critical.intervals || []).map((r) => {
      let a = T.clock(r.start, { assume24: true }),
        b = T.clock(r.end, { assume24: true }),
        mins = b.minutes - a.minutes;
      if (mins < 0) mins += 1440;
      return {
        ...r,
        date: r.date || f.date,
        endDate:
          r.endDate ||
          (b.minutes < a.minutes
            ? T.addDays(r.date || f.date, 1)
            : r.date || f.date),
        minutes: mins,
        crossesMidnight: b.minutes < a.minutes,
      };
    });
    return { ok: true, errors: [], facts: applyOverrides(f, context) };
  }
  function makePacket(note, context, data) {
    const local = localExtract(note, context, data),
      rules = relevantRules(local, data, 14);
    return {
      schema_version: 1,
      request:
        "Extract documented physician services and evidence, NOT fee codes. Do not infer times, procedures or clinical severity from a desired payment.",
      context: {
        date: context.date || null,
        time: context.time || null,
        role: context.role || null,
        shiftDate: context.shiftDate || null,
        shiftStart: context.shiftStart || null,
      },
      action_catalog: data.services.map((s) => ({
        id: s.id,
        label: s.label,
        fields: s.fields,
      })),
      rules: rules.map((r) => ({
        id: r.id,
        text: r.body,
        status: r.review_status,
      })),
      note,
    };
  }
  function analyze(note, context, data, ledger = []) {
    const begin = performance.now(),
      ctx = { ...context, note };
    const facts = localExtract(note, ctx, data),
      result = compile(facts, ctx, data, ledger);
    return { facts, result, totalMs: performance.now() - begin };
  }
  return {
    analyze,
    localExtract,
    compile,
    applyOverrides,
    validateExtraction,
    mergeModel,
    makePacket,
    semanticSearch,
    relevantRules,
    proof,
    hash,
    assertion,
    actor,
    siteFrom,
    method,
    pickProcedure,
  };
});
