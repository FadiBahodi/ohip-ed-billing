// WebLLM includes Qwen3's forced empty thinking prefill in message.content.
// Remove only that known empty prefix; substantive non-JSON output is an error.
export function parseInterpretation(content) {
  return JSON.parse(content.replace(/^\s*<think>\s*<\/think>\s*/, "").trim());
}
export function evidencePassages(note) {
  return Object.fromEntries([
    ["S0", note],
    ...note
      .split(/\n+|(?<=[.!?;])\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((text, i) => ["S" + (i + 1), text]),
  ]);
}
export function resolveEvidence(result, passages) {
  for (const item of [
    result.assessment,
    ...result.work,
    ...result.services,
    ...result.opportunities,
    ...(result.care ? [result.care, ...result.care.episodes] : []),
  ]) {
    if (!Object.hasOwn(passages, item.quote))
      throw Error("Unknown evidence reference.");
    item.quote = passages[item.quote];
  }
  return result;
}

export function chunkNote(note, maximum = 1600) {
  // Bound prompt size without losing any source span, including a single
  // oversized paragraph. Short notes retain exactly the previous input.
  const out = [];
  let start = 0;
  while (start < note.length) {
    let end = Math.min(start + maximum, note.length);
    if (end < note.length) {
      let cut = note.lastIndexOf("\n", end);
      if (cut < start + maximum / 3) cut = note.lastIndexOf(" ", end);
      if (cut > start) end = cut;
    }
    const text = note.slice(start, end).trim();
    if (text) out.push(text);
    start = end;
    while (/\s/.test(note[start] || "") && start < note.length) start++;
  }
  return out.length ? out : [""];
}
export function mergeInterpretations(parts) {
  if (parts.length === 1) return parts[0];
  const unique = (arr, key) => [
    ...new Map(arr.map((x) => [key(x), x])).values(),
  ];
  const rank = { none: 0, minor: 1, multisystem: 2, comprehensive: 3 };
  const assessment = [...parts].sort(
    (a, b) => rank[b.assessment.level] - rank[a.assessment.level],
  )[0].assessment;
  const careParts = parts.filter((x) => x.care?.tier && x.care.tier !== "none");
  const strongest =
    careParts.find((x) => x.care.tier === "life") ||
    careParts[0] ||
    parts.find((x) => x.care);
  const care = strongest?.care
    ? {
        ...strongest.care,
        episodes: unique(
          careParts.flatMap((x) => x.care.episodes),
          (e) => [e.quote, e.kind, e.start, e.end].join("|"),
        ),
      }
    : null;
  return {
    assessment,
    care,
    reassessments: unique(
      parts.flatMap((x) => x.reassessments || []),
      (x) => x.time + "|" + x.quote,
    ),
    work: unique(
      parts.flatMap((x) => x.work),
      (x) => x.quote + "|" + x.label,
    ),
    services: unique(
      parts.flatMap((x) => x.services),
      (x) => [x.service, x.actor, x.status, x.quote].join("|"),
    ),
    opportunities: unique(
      parts.flatMap((x) => x.opportunities),
      (x) => x.pathway + "|" + x.quote,
    ),
  };
}
