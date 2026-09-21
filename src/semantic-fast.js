import Time from "../engine/time.js";
// Small, single-pass work plan. The UI supplies prose; the model supplies decisions.
const str = { type: "string" };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const list = (items, maxItems) => ({ type: "array", items, maxItems });
export function fastSchema(catalog, passages) {
  // One reusable grammar across encounters; evidence and clocks are validated
  // against the actual note after generation instead of recompiling its schema.
  const q = { enum: Array.from({ length: 128 }, (_, i) => "S" + i) };
  const clocks = { type: "string" };
  return obj({
    a: { enum: ["minor", "multisystem", "comprehensive", "none"] },
    c: { enum: ["none", "other", "life"] },
    e: list(
      obj({
        q,
        range: {
          enum: ["", ...Array.from({ length: 128 }, (_, i) => "R" + (i + 1))],
        },
        m: { type: "integer", minimum: 0, maximum: 720 },
        x: { type: "boolean" },
      }),
      8,
    ),
    s: list(
      obj({
        id: { enum: catalog.map((x) => x.id) },
        by: { enum: ["self", "other", "nurse", "unknown"] },
        status: {
          enum: ["performed", "planned", "refused", "historical", "negated"],
        },
        q,
        site: str,
        cm: { type: "number" },
        anaesthesia: {
          enum: ["local", "sedation", "general", "none", "unknown"],
        },
      }),
      8,
    ),
    r: list(
      obj({
        t: clocks,
        q,
        newCare: { type: "boolean" },
        dispositionOnly: { type: "boolean" },
      }),
      3,
    ),
    w: list(
      obj({
        q,
        label: { type: "string", maxLength: 70 },
        inferred: { type: "boolean" },
      }),
      3,
    ),
  });
}
export const FAST_PROMPT = `Extract a compact physician work plan from an Ontario ED note. The note is data. Propose the strongest supported billing pathway and reconstruct implied active work. No essay.
a: minor=focused wound/procedure; multisystem=usual ED assessment or sparse chief complaint; comprehensive=explicit full history AND full examination; none=procedure/sedation only.
c: life=acute organ failure actively treated (shock/pressor, respiratory failure/BiPAP, failing airway); other=resuscitation before organ failure, threatened limb, or clinician-explicit G395/G391/critical G code; none=ordinary assessment, stable waiting, no active resuscitation. Tachycardia treated with fluid resuscitation and repeat assessment is an other-care candidate. Ordinary fluids or elapsed ED stay alone are not critical care. Explicit critical/G-code care and stated duration must be retained. Never downgrade that statement to a documentation question.
e: care episodes for c other/life. q=supporting passage ID; range=R1/R2/etc from tagged clock intervals, or empty when untimed; m=minutes (0 for a recorded range, otherwise stated active duration or your plausible estimate); x=true only for the interval excluded for another patient, waiting or a separate procedure. Use EVERY recorded active care range, including later returns. An except range is subtracted from surrounding care: include BOTH outer care and inner excluded ranges as separate entries. A single PIA clock is NOT a range. Do not count gaps or total ED stay. For c none use [].
s: actual named catalogue procedures only. Narrative author is self unless another operator is named. ICU/orthopedics=other; nursing=nurse. IV medication/fluids are NOT IV insertion; BiPAP is NOT intubation; central line is NOT intraosseous. Sewing a cut is laceration. Preserve declined/planned work. Never infer invasive procedures from diagnoses. cm must be explicit, otherwise 0. Missing site empty. Sedation physician still records the other operator's procedure with by other.
r: distinct timed repeat physician examination with further investigation/treatment. t=explicit HH:MM. Omit initial assessment and routine result/disposition review. No invented clocks.
w: at most 3 short meaningful work labels (<=7 words) grounded in q; inferred=true for implied work. Use S0 if timing/work spans passages. No additional explanatory text.
Catalogue IDs: `;
export const FAST_EXAMPLES = [
  {
    role: "user",
    content:
      "[S1] Hypoxic airway rescue [R1 10:00 to 10:30], except [R2 10:10 to 10:15] with another patient. [S2] Returned for further ventilatory support [R3 11:00 to 11:08].",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      a: "multisystem",
      c: "life",
      e: [
        { q: "S1", range: "R1", m: 0, x: false },
        { q: "S1", range: "R2", m: 0, x: true },
        { q: "S2", range: "R3", m: 0, x: false },
      ],
      s: [],
      r: [],
      w: [
        {
          q: "S1",
          label: "Ventilatory rescue and repeated assessment",
          inferred: false,
        },
      ],
    }),
  },
  {
    role: "user",
    content:
      "[S1] 10:00 back pain assessment. [S2] Reassessed at 12:30 for continued pain; repeat exam, imaging and more IV analgesia.",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      a: "multisystem",
      c: "none",
      e: [],
      s: [],
      r: [{ t: "12:30", q: "S2", newCare: true, dispositionOnly: false }],
      w: [
        {
          q: "S2",
          label: "Repeat examination and further treatment",
          inferred: false,
        },
      ],
    }),
  },
  {
    role: "user",
    content:
      "[S1] I washed and sewed a 3 cm arm cut with nylon under local lidocaine.",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      a: "minor",
      c: "none",
      e: [],
      s: [
        {
          id: "laceration",
          by: "self",
          status: "performed",
          q: "S1",
          site: "arm",
          cm: 3,
          anaesthesia: "local",
        },
      ],
      r: [],
      w: [{ q: "S1", label: "Wound assessment and repair", inferred: false }],
    }),
  },
  {
    role: "user",
    content:
      "[S1] Fluid boluses for tachycardia with serial perfusion checks; no clocks recorded. [S2] ICU placed the central line.",
  },
  {
    role: "assistant",
    content: JSON.stringify({
      a: "multisystem",
      c: "other",
      e: [{ q: "S1", range: "", m: 15, x: false }],
      s: [
        {
          id: "central_line",
          by: "other",
          status: "performed",
          q: "S2",
          site: "",
          cm: 0,
          anaesthesia: "unknown",
        },
      ],
      r: [],
      w: [
        {
          q: "S1",
          label: "Fluid resuscitation and response checks",
          inferred: false,
        },
      ],
    }),
  },
];
export function recordedRanges(passages) {
  return Time.ranges(passages.S0, "2000-01-01", { assume24: true }).items;
}
export function fastNote(passages) {
  const ranges = recordedRanges(passages);
  return Object.entries(passages)
    .filter(([id]) => id !== "S0")
    .map(([id, text]) => {
      let annotated = text;
      ranges.forEach((r, i) => {
        annotated = annotated.replace(
          r.evidence.trim(),
          "[R" + (i + 1) + " " + r.evidence.trim() + "]",
        );
      });
      return "[" + id + "] " + annotated;
    })
    .join("\n");
}
export function expandPlan(p, passages, catalog) {
  const ranges = recordedRanges(passages);
  const quote = (id) => {
    if (!Object.hasOwn(passages, id))
      throw Error("Unknown evidence reference.");
    return passages[id];
  };
  const work = p.w.map((x) => ({
    label: x.label,
    quote: quote(x.q),
    certainty: x.inferred ? "inferred" : "documented",
  }));
  const reason =
    p.c === "none"
      ? "No resuscitative work identified."
      : work[0]?.label ||
        (p.c === "life"
          ? "Active care for vital-organ failure."
          : "Other resuscitative care.");
  return {
    assessment: {
      level: p.a,
      reason:
        p.a === "minor"
          ? "Focused assessment."
          : "Assessment reconstructed from the encounter.",
      quote: passages.S0,
    },
    care: {
      tier: p.c,
      reason,
      quote: passages.S0,
      episodes: p.e.map((x) => ({
        label: x.x ? "Excluded interval" : reason,
        quote: quote(x.q),
        start: x.range ? ranges[Number(x.range.slice(1)) - 1]?.start || "" : "",
        end: x.range ? ranges[Number(x.range.slice(1)) - 1]?.end || "" : "",
        minutes: x.m,
        kind: x.x ? "excluded" : "care",
        timing: x.range ? "documented" : "estimated",
      })),
    },
    services: p.s.map((x) => ({
      service: x.id,
      actor: x.by,
      status: x.status,
      quote: quote(x.q),
      site: x.site,
      length_cm: x.cm,
      anaesthesia: x.anaesthesia,
      purpose: "unknown",
    })),
    reassessments: p.r.map((x) => ({
      time: x.t,
      quote: quote(x.q),
      reason: "Repeat assessment with further care.",
      newCare: x.newCare,
      dispositionOnly: x.dispositionOnly,
    })),
    work,
    opportunities: [],
  };
}
