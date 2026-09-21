import { INSTRUCTIONS } from "./semantic-prompt.js";
import { MLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import {
  parseInterpretation,
  evidencePassages,
  resolveEvidence,
} from "./semantic-response.js";
// Model artifacts are fetched with GET. Notes are passed only to local inference.
const networkFetch = self.fetch.bind(self);
self.fetch = async (input, init = {}) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
    self.location.href,
  );
  const method =
    init.method || (typeof input !== "string" ? input.method : "GET") || "GET";
  if (
    method.toUpperCase() !== "GET" ||
    ![
      "https://huggingface.co",
      "https://raw.githubusercontent.com",
      self.location.origin,
    ].includes(url.origin)
  )
    throw Error("Only model artifact downloads are allowed.");
  // Consume each binary shard under a deadline so a stalled CDN body cannot
  // leave the model indefinitely stuck at one percentage. Completed shards
  // remain in WebLLM's cache and are reused when initialization is retried.
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(45000);
    const original = init.signal || input?.signal;
    const signal = original ? AbortSignal.any([original, timeout]) : timeout;
    try {
      const response = await networkFetch(input, {
        ...init,
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok)
        throw Error(
          `Model download failed (${response.status}): ${url.pathname.split("/").at(-1)}`,
        );
      if (!url.pathname.endsWith(".bin")) return response;
      const bytes = await response.arrayBuffer();
      return new Response(bytes, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      if (original?.aborted || attempt === 2) throw error;
    }
  }
};
// Cache.add uses the browser's internal fetch and would bypass the wrapper.
// Keep WebLLM's existing cache keys, but route downloads through bounded GETs.
if (self.Cache) {
  Cache.prototype.add = async function (request) {
    const response = await self.fetch(request);
    await this.put(request, response);
  };
}
const MODEL = "Qwen3-4B-q4f16_1-MLC";
let engine,
  loading,
  pending,
  busy = false,
  generating = false,
  paused = false;
const send = (type, data = {}) => postMessage({ type, ...data });
async function initialize() {
  if (loading) return loading;
  loading = (async () => {
    if (!self.navigator.gpu)
      throw Error(
        "This browser does not expose WebGPU. Open Folio in Chrome or Edge for the on-device model.",
      );
    send("status", {
      status: "loading",
      message: "Downloading local AI · first use only",
    });
    const record = prebuiltAppConfig.model_list.find(
      (x) => x.model_id === MODEL,
    );
    engine = new MLCEngine({
      appConfig: { model_list: [record], cacheBackend: "cache" },
      initProgressCallback: (p) =>
        send("status", {
          status: "loading",
          progress: p.progress,
          message: p.text,
        }),
    });
    await engine.reload(MODEL, { context_window_size: 4096 });
    send("status", {
      status: "ready",
      message: "Local AI ready",
      model: MODEL,
    });
  })().catch((error) => {
    loading = null;
    send("status", { status: "error", message: error.message });
    throw error;
  });
  return loading;
}
const str = { type: "string" };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function schema(catalog, passages) {
  const quote = { enum: Object.keys(passages) };
  return object({
    assessment: object({
      level: { enum: ["minor", "multisystem", "comprehensive", "none"] },
      reason: str,
      quote,
    }),
    work: {
      type: "array",
      maxItems: 4,
      items: object({
        label: str,
        quote,
        certainty: { enum: ["documented", "inferred", "possible"] },
      }),
    },
    services: {
      type: "array",
      maxItems: 6,
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
    opportunities: {
      type: "array",
      maxItems: 2,
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
function prompt(catalog) {
  return (
    INSTRUCTIONS +
    catalog.map((x) => x.id + "=" + x.label).join("; ") +
    "\n/no_think"
  );
}
async function drain() {
  if (busy || paused || !pending) return;
  busy = true;
  try {
    await initialize();
    while (pending && !paused) {
      const job = pending;
      pending = null;
      send("status", {
        status: "thinking",
        id: job.id,
        message: "Reading the encounter…",
      });
      const started = performance.now();
      const passages = evidencePassages(job.note);
      try {
        generating = true;
        const response = await engine.chat.completions.create({
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: prompt(job.catalog) },
            {
              role: "user",
              content: "ENCOUNTER NOTE:\n[S1] 23F sore throat, 15 min.",
            },
            {
              role: "assistant",
              content: JSON.stringify({
                assessment: {
                  level: "minor",
                  reason: "Focused assessment of a single complaint.",
                  quote: "S1",
                },
                work: [
                  {
                    label: "Sore throat assessment",
                    quote: "S1",
                    certainty: "inferred",
                  },
                ],
                services: [],
                opportunities: [],
              }),
            },
            {
              role: "user",
              content:
                "ENCOUNTER NOTE:\n[S1] 4 cm leg wound, washed out, closed with nylon by me. [S2] Local lidocaine.",
            },
            {
              role: "assistant",
              content: JSON.stringify({
                assessment: {
                  level: "minor",
                  reason: "Focused wound assessment with repair.",
                  quote: "S1",
                },
                work: [
                  {
                    label: "Wound assessment and closure",
                    quote: "S1",
                    certainty: "documented",
                  },
                ],
                services: [
                  {
                    service: "laceration",
                    actor: "self",
                    status: "performed",
                    quote: "S1",
                    site: "leg",
                    anaesthesia: "local",
                    purpose: "repair",
                    length_cm: 4,
                  },
                ],
                opportunities: [],
              }),
            },
            {
              role: "user",
              content:
                "ENCOUNTER NOTE:\n" +
                Object.entries(passages)
                  .filter(([id]) => id !== "S0")
                  .map(([id, text]) => "[" + id + "] " + text)
                  .join("\n"),
            },
          ],
          temperature: 0,
          max_tokens: 900,
          extra_body: { enable_thinking: false },
          response_format: {
            type: "json_object",
            schema: JSON.stringify(schema(job.catalog, passages)),
          },
        });
        let content = "",
          finishReason = null,
          usage;
        for await (const chunk of response) {
          content += chunk.choices[0]?.delta?.content || "";
          finishReason = chunk.choices[0]?.finish_reason || finishReason;
          if (chunk.usage) usage = chunk.usage;
        }
        generating = false;
        if (pending || paused) continue;
        if (finishReason !== "stop")
          throw Error(
            "Interpretation was interrupted or exceeded the output limit.",
          );
        const interpretation = resolveEvidence(
          parseInterpretation(content),
          passages,
        );
        send("status", { status: "ready", message: "Local AI ready" });
        send("result", {
          id: job.id,
          interpretation,
          elapsed: performance.now() - started,
          usage,
        });
      } catch (error) {
        generating = false;
        if (!pending && !paused)
          send("error", { id: job.id, message: error.message });
      }
    }
  } catch {
  } finally {
    busy = false;
  }
}
self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "analyze") {
    paused = false;
    pending = msg;
    if (generating && engine) engine.interruptGenerate();
    drain();
  } else if (msg.type === "init") {
    paused = false;
    initialize().catch(() => {});
  } else if (msg.type === "cancel") {
    pending = null;
    if (generating && engine) engine.interruptGenerate();
  } else if (msg.type === "pause") {
    paused = true;
    pending = null;
    if (generating && engine) engine.interruptGenerate();
    send("status", { status: "paused", message: "Local AI paused" });
  }
};
