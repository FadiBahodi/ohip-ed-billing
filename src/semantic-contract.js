const str = { type: "string" };
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export function schema(catalog, passages) {
  const quote = { enum: Object.keys(passages) };
  return object({
    assessment: object({
      level: { enum: ["minor", "multisystem", "comprehensive", "none"] },
      reason: str,
      quote,
    }),
    work: {
      type: "array",
      maxItems: 6,
      items: object({
        label: str,
        quote,
        certainty: { enum: ["documented", "inferred", "possible"] },
      }),
    },
    services: {
      type: "array",
      maxItems: 8,
      items: object({
        service: { enum: catalog.map((s) => s.id) },
        actor: { enum: ["self", "other", "nurse", "unknown"] },
        status: {
          enum: ["performed", "planned", "refused", "historical", "negated"],
        },
        quote,
        site: str,
        anaesthesia: {
          enum: ["local", "sedation", "general", "none", "unknown"],
        },
        purpose: str,
        length_cm: { type: "number" },
      }),
    },
    care: object({
      tier: { enum: ["none", "other", "life"] },
      reason: str,
      quote,
      episodes: {
        type: "array",
        maxItems: 8,
        items: object({
          label: str,
          quote,
          kind: { enum: ["care", "excluded"] },
          start: str,
          end: str,
          minutes: { type: "integer", minimum: 0, maximum: 720 },
          timing: { enum: ["documented", "estimated"] },
        }),
      },
    }),
    opportunities: {
      type: "array",
      maxItems: 4,
      items: object({
        title: str,
        detail: str,
        quote,
        pathway: {
          enum: [
            "critical_life",
            "critical_other",
            "reassessment",
            "documentation",
            "other",
          ],
        },
      }),
    },
  });
}
