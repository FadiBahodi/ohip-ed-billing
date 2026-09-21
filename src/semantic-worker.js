import {
  FAST_PROMPT,
  FAST_EXAMPLES,
  fastSchema,
  expandPlan,
  fastNote,
} from "./semantic-fast.js";
import { INSTRUCTIONS } from "./semantic-prompt.js";
import { schema } from "./semantic-contract.js";
import {
  SERVICE_REVIEW,
  REASSESSMENT_REVIEW,
  serviceReviewSchema,
  reassessmentSchema,
} from "./semantic-review.js";
import { MLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import {
  parseInterpretation,
  evidencePassages,
  resolveEvidence,
  chunkNote,
  mergeInterpretations,
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
const ALLOWED_MODELS = [
  "Qwen3-4B-q4f16_1-MLC",
  "Qwen3.5-2B-q4f16_1-MLC",
  "Qwen3.5-4B-q4f16_1-MLC",
];
let MODEL = "Qwen3.5-4B-q4f16_1-MLC";
let engine,
  loading,
  pending,
  busy = false,
  generating = false,
  paused = false;
const send = (type, data = {}) => postMessage({ type, ...data });
async function initialize(warmCatalog) {
  if (loading) return loading;
  loading = (async () => {
    if (!self.navigator.gpu)
      throw Error(
        "This browser does not expose WebGPU. Use a WebGPU-capable browser for local AI.",
      );
    send("status", {
      status: "loading",
      message: "Preparing local AI · cached files are reused",
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
    if (warmCatalog?.length) {
      send("status", {
        status: "loading",
        progress: 1,
        message: "Preparing interpretation cache…",
      });
      // Prime the reusable grammar before the first clinical note. One output
      // token is enough; the synthetic request is never stored or displayed.
      await engine.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              FAST_PROMPT +
              warmCatalog.map((x) => x.id).join(", ") +
              "\n/no_think",
          },
          ...FAST_EXAMPLES,
          { role: "user", content: "[S1] No clinical encounter entered." },
        ],
        temperature: 0,
        max_tokens: 1,
        extra_body: { enable_thinking: false },
        response_format: {
          type: "json_object",
          schema: JSON.stringify(fastSchema(warmCatalog, { S0: "", S1: "" })),
        },
      });
    }
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
function prompt(catalog) {
  return (
    INSTRUCTIONS +
    catalog.map((x) => x.id + "=" + x.label).join("; ") +
    "\n/no_think"
  );
}
async function inferLegacy(job, note) {
  const passages = evidencePassages(note);
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
          care: {
            tier: "none",
            reason: "No resuscitative work.",
            quote: "S1",
            episodes: [],
          },
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
          care: {
            tier: "none",
            reason: "No resuscitative work.",
            quote: "S1",
            episodes: [],
          },
          opportunities: [],
        }),
      },
      {
        role: "user",
        content:
          "ENCOUNTER NOTE:\n[S1] Stridor, hypoxia and unable to speak. I gave IM adrenaline twice, nebulized adrenaline and reassessed airway and oxygenation repeatedly.\n[S2] No clocks charted.",
      },
      {
        role: "assistant",
        content:
          '{"assessment": {"level": "multisystem", "reason": "Emergency airway assessment and resuscitation.", "quote": "S1"}, "work": [{"label": "Airway rescue and treatment-response checks", "quote": "S1", "certainty": "documented"}], "services": [], "care": {"tier": "life", "reason": "Failing airway with hypoxia and active rescue.", "quote": "S1", "episodes": [{"label": "Airway rescue and repeated response checks; proposed active time", "quote": "S1", "kind": "care", "start": "", "end": "", "minutes": 18, "timing": "estimated"}]}, "opportunities": [{"title": "Capture response to rescue treatment", "detail": "Record the serial airway findings and response to each adrenaline dose, if this reflects your work.", "quote": "S1", "pathway": "documentation"}]}',
      },
      {
        role: "user",
        content:
          "ENCOUNTER NOTE:\n[S1] Pulseless displaced ankle; urgent reduction and neurovascular rescue. I attended 15:00 to 15:12, except 15:04 to 15:07 with a different patient. Circulation returned.",
      },
      {
        role: "assistant",
        content:
          '{"assessment": {"level": "minor", "reason": "Focused limb assessment included in rescue care.", "quote": "S1"}, "work": [{"label": "Threatened-limb rescue", "quote": "S1", "certainty": "documented"}], "services": [], "care": {"tier": "other", "reason": "Threatened limb requiring urgent resuscitative work.", "quote": "S1", "episodes": [{"label": "Limb rescue", "quote": "S1", "kind": "care", "start": "15:00", "end": "15:12", "minutes": 12, "timing": "documented"}, {"label": "Other patient", "quote": "S1", "kind": "excluded", "start": "15:04", "end": "15:07", "minutes": 3, "timing": "documented"}]}, "opportunities": []}',
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
    max_tokens: 1500,
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
  if (finishReason !== "stop")
    throw Error("Interpretation was interrupted or exceeded the output limit.");
  let interpretation = resolveEvidence(parseInterpretation(content), passages);
  interpretation = await reviewWork(job, note, passages, interpretation);
  return { interpretation, usage };
}
async function infer(job, note) {
  if (job.pipeline === "legacy") return inferLegacy(job, note);
  const passages = evidencePassages(note);
  generating = true;
  const started = performance.now();
  const response = await engine.chat.completions.create({
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      {
        role: "system",
        content:
          FAST_PROMPT + job.catalog.map((x) => x.id).join(", ") + "\n/no_think",
      },
      ...FAST_EXAMPLES,
      {
        role: "user",
        content: fastNote(passages),
      },
    ],
    temperature: 0,
    max_tokens: 900,
    extra_body: { enable_thinking: false },
    response_format: {
      type: "json_object",
      schema: JSON.stringify(fastSchema(job.catalog, passages)),
    },
  });
  let content = "",
    finish,
    usage,
    firstTokenMs;
  for await (const chunk of response) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (delta && firstTokenMs === undefined)
      firstTokenMs = performance.now() - started;
    content += delta;
    finish = chunk.choices[0]?.finish_reason || finish;
    if (chunk.usage) usage = chunk.usage;
  }
  generating = false;
  if (finish !== "stop")
    throw Error("Interpretation was interrupted or exceeded the output limit.");
  let interpretation = expandPlan(
    parseInterpretation(content),
    passages,
    job.catalog,
  );
  // Only procedure-bearing notes need attribution review. Ordinary encounters
  // and timed care avoid the old always-on follow-up pass.
  if (
    interpretation.services.length ||
    job.candidates?.some((s) => s.anaesthesia === "sedation")
  )
    interpretation = await reviewWork(
      job,
      note,
      passages,
      interpretation,
      true,
    );
  return {
    interpretation,
    usage: { ...usage, firstTokenMs, pipeline: "compact" },
  };
}
async function shortTask(messages, schema, limit = 300) {
  generating = true;
  const response = await engine.chat.completions.create({
    stream: true,
    messages,
    temperature: 0,
    max_tokens: limit,
    extra_body: { enable_thinking: false },
    response_format: { type: "json_object", schema: JSON.stringify(schema) },
  });
  let content = "",
    finish = null;
  for await (const chunk of response) {
    content += chunk.choices[0]?.delta?.content || "";
    finish = chunk.choices[0]?.finish_reason || finish;
  }
  generating = false;
  if (finish !== "stop")
    throw Error("Local work check was interrupted (" + finish + ").");
  return parseInterpretation(content);
}
async function reviewWork(job, note, passages, result, proceduresOnly = false) {
  const services = [];
  const candidates = [
    ...result.services,
    ...(job.candidates || []).filter(
      (s) =>
        note.includes(s.quote) &&
        !result.services.some((e) => e.service === s.service),
    ),
  ];
  for (const service of candidates) {
    if (pending || paused) break;
    send("status", {
      status: "thinking",
      id: job.id,
      message: "Checking procedure attribution…",
    });
    const reviewed = await shortTask(
      [
        { role: "system", content: SERVICE_REVIEW },
        {
          role: "user",
          content:
            "NOTE: I sewed the cut with nylon. SERVICE: Laceration repair.",
        },
        {
          role: "assistant",
          content: '{"supported":true,"actor":"self","status":"performed"}',
        },
        {
          role: "user",
          content:
            "NOTE: Ordered IV morphine. SERVICE: Intravenous line insertion.",
        },
        {
          role: "assistant",
          content: '{"supported":false,"actor":"unknown","status":"planned"}',
        },
        {
          role: "user",
          content:
            "NOTE: ICU placed a jugular central line. SERVICE: Central venous line insertion.",
        },
        {
          role: "assistant",
          content: '{"supported":true,"actor":"other","status":"performed"}',
        },
        {
          role: "user",
          content:
            "NOTE: " +
            note +
            "\nSERVICE: " +
            (job.catalog.find((x) => x.id === service.service)?.label ||
              service.service),
        },
      ],
      serviceReviewSchema,
      100,
    );
    if (reviewed.supported)
      services.push({
        ...service,
        actor: reviewed.actor,
        status: reviewed.status,
      });
  }
  result.services = services;
  if (
    !proceduresOnly &&
    result.care.tier === "none" &&
    (note.match(/\b\d{1,2}:\d{2}\b/g) || []).length > 1 &&
    !pending &&
    !paused
  ) {
    send("status", {
      status: "thinking",
      id: job.id,
      message: "Recovering repeat assessment work…",
    });
    const reviewed = await shortTask(
      [
        { role: "system", content: REASSESSMENT_REVIEW },
        {
          role: "user",
          content:
            "[S1] Initial 10:00 abdominal pain. [S2] At 12:30 repeated abdominal exam for continued pain, ordered ultrasound and further analgesia.",
        },
        {
          role: "assistant",
          content:
            '{"reassessments":[{"time":"12:30","reason":"Repeat exam for persistent pain with new imaging and analgesia.","quote":"S2","newCare":true,"dispositionOnly":false}]}',
        },
        {
          role: "user",
          content:
            "[S1] 10:00 assessed. [S2] 11:00 normal labs reviewed and discharged.",
        },
        { role: "assistant", content: '{"reassessments":[]}' },
        {
          role: "user",
          content: Object.entries(passages)
            .filter(([id]) => id !== "S0")
            .map(([id, t]) => "[" + id + "] " + t)
            .join("\n"),
        },
      ],
      reassessmentSchema(passages),
      350,
    );
    result.reassessments = reviewed.reassessments.map((r) => {
      if (!Object.hasOwn(passages, r.quote))
        throw Error("Unknown reassessment evidence.");
      return { ...r, quote: passages[r.quote] };
    });
  }
  return result;
}
async function drain() {
  if (busy || paused || !pending) return;
  busy = true;
  try {
    await initialize();
    while (pending && !paused) {
      const job = pending;
      pending = null;
      const started = performance.now(),
        chunks = chunkNote(job.note),
        parts = [];
      let usage;
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (pending || paused) break;
          send("status", {
            status: "thinking",
            id: job.id,
            message:
              chunks.length > 1
                ? `Reading section ${i + 1} of ${chunks.length}…`
                : "Interpreting work…",
          });
          const result = await infer(job, chunks[i]);
          parts.push(result.interpretation);
          usage = result.usage;
        }
        if (pending || paused) continue;
        send("status", {
          id: job.id,
          status: "ready",
          message: "Local AI ready",
        });
        send("result", {
          id: job.id,
          interpretation: mergeInterpretations(parts),
          elapsed: performance.now() - started,
          usage,
          model: MODEL,
          sections: chunks.length,
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
    if (!engine && ALLOWED_MODELS.includes(msg.model)) MODEL = msg.model;
    paused = false;
    pending = msg;
    if (generating && engine) engine.interruptGenerate();
    drain();
  } else if (msg.type === "init") {
    paused = false;
    if (!engine && ALLOWED_MODELS.includes(msg.model)) MODEL = msg.model;
    initialize(msg.catalog).catch(() => {});
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
