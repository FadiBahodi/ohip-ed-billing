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
  ]) {
    if (!Object.hasOwn(passages, item.quote))
      throw Error("Unknown evidence reference.");
    item.quote = passages[item.quote];
  }
  return result;
}
