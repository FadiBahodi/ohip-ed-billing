"use strict";
const D = FASTBILL_DATA,
  F = FastBill,
  V = BillingEngine,
  T = FastTime,
  C = FolioCore,
  A = FolioAssist,
  PROFILE = window.FOLIO_SOURCES?.profile || {
    id: "cvh-ed",
    ecgInterpretation: false,
    assessmentDefault: "multisystem",
  };
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const E = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (["checked", "disabled", "value", "hidden"].includes(k)) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c !== null && c !== undefined && c !== false)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};
const KEY = "folio.billing.v1";
const state = {
  id: crypto.randomUUID(),
  ctx: { overrides: {} },
  facts: null,
  result: null,
  base: null,
  manual: [],
  removed: [],
  ledger: [],
  shiftName: "My shift",
  session: new Map(),
  reviewed: false,
  dirty: false,
  savedOnly: false,
  page: "build",
  clock: null,
  semantic: null,
  ai: { status: "idle", message: "Local AI starts with your note" },
};
const labels = {
  minor: "Minor assessment",
  multisystem: "Detailed assessment of multiple systems",
  comprehensive: "Comprehensive assessment",
  none: "No qualifying critical care",
  other: "Threatened life / limb + active rescue",
  life: "Acute organ failure + active critical care",
  self: "I performed it",
  nurse: "Nursing / another team member",
  yes: "Yes",
  no: "No",
  local: "Local / regional block",
  sedation: "Procedural sedation",
  general: "General anaesthesia",
  primary: "Primary ED physician",
  procedure_only: "Procedure only",
  assistant: "Assisting only",
  handover: "Active handover",
  unknown: "Not confirmed",
  ohip: "OHIP",
  wsib: "WSIB",
  selfpay: "Self-pay",
  regular: "Regular shift",
  svp: "Special visit",
};
let toastTimer;
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
function modal(title, ...body) {
  $("#modal-title").textContent = title;
  $("#modal-body").replaceChildren(...body.flat(Infinity).filter(Boolean));
  if (!$("#modal").open) $("#modal").showModal();
}
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) $("#modal").close();
});
function persist() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        shiftName: state.shiftName,
        ledger: state.ledger,
      }),
    );
    return true;
  } catch {
    toast(
      "Device storage unavailable. Export a JSON backup before closing this tab.",
    );
    return false;
  }
}
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const data = C.importBackup(JSON.parse(raw), D);
    state.ledger = data.ledger;
    state.shiftName = data.shiftName;
  }
} catch {
  setTimeout(
    () =>
      toast(
        "Saved shift could not be restored. The original storage was left unchanged; restore a backup to recover.",
      ),
    300,
  );
}
function navigate(page) {
  state.page = ["build", "library", "shift"].includes(page) ? page : "build";
  $$(".page").forEach((p) => (p.hidden = p.id !== "page-" + state.page));
  $$(".nav").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === state.page);
    if (b.dataset.page === state.page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  history.replaceState(null, "", "#" + state.page);
  if (state.page === "library") search();
  if (state.page === "shift") renderShift();
}
$$(".nav").forEach((b) => (b.onclick = () => navigate(b.dataset.page)));
$(".brand").onclick = (e) => {
  e.preventDefault();
  navigate("build");
};
function context() {
  return {
    ecgAllowed: PROFILE.ecgInterpretation,
    defaultAssessment: PROFILE.assessmentDefault,
    ...state.ctx,
    encounterId: state.id,
    note: $("#note").value,
  };
}
function remember() {
  if ($("#note").value.trim() || state.manual.length)
    state.session.set(state.id, {
      note: $("#note").value,
      reference: $("#reference").value,
      ctx: structuredClone(state.ctx),
      manual: structuredClone(state.manual),
      removed: [...state.removed],
      reviewed: state.reviewed,
      time: state.facts?.time,
      clock: state.clock ? { ...state.clock } : null,
      semantic: state.semantic,
      semanticMs: state.semanticMs,
    });
}
function syncInputs() {
  $("#context-date").value =
    state.ctx.date || state.facts?.date || state.clock?.date || A.clock().date;
  $("#context-time").value =
    state.ctx.time || state.facts?.time || state.clock?.time || A.clock().time;
  $("#context-role").value = state.ctx.role || "";
  $("#context-payer").value = state.ctx.payer || "";
  $("#context-pathway").value = state.ctx.pathway || "regular";
  $("#context-holiday").checked = !!state.ctx.holiday;
}
function newEncounter() {
  interpreter?.cancel();
  clearTimeout(semanticTimer);
  remember();
  Object.assign(state, {
    id: crypto.randomUUID(),
    ctx: { overrides: {} },
    facts: null,
    result: null,
    base: null,
    manual: [],
    removed: [],
    reviewed: false,
    dirty: false,
    savedOnly: false,
    clock: null,
    semantic: null,
  });
  $("#note").value = "";
  $("#reference").value = "";
  syncInputs();
  render();
  renderSidebar();
  navigate("build");
  $("#note").focus();
}
$$(".new-encounter").forEach((b) => (b.onclick = newEncounter));
let interpreter = null,
  semanticTimer,
  liveTimer;
function defaultReference() {
  return "Encounter " + String(state.ledger.length + 1).padStart(2, "0");
}
function initInterpreter() {
  if (interpreter || !window.FolioInterpreter) return;
  interpreter = new window.FolioInterpreter({
    onStatus: updateAI,
    onResult: (m) => {
      if (
        state.requestNote !== $("#note").value.trim() ||
        state.requestEncounter !== state.id
      )
        return;
      const validated = A.validate(m.interpretation, state.requestNote, D);
      if (!validated.ok) {
        updateAI({
          status: "error",
          message: "Interpretation needs another pass: " + validated.errors[0],
        });
        return;
      }
      const apply = () => {
        if (
          state.requestNote !== $("#note").value.trim() ||
          state.requestEncounter !== state.id
        )
          return;
        state.semantic = m.interpretation;
        state.semanticMs = m.elapsed;
        build({ requestAI: false });
      };
      const focused = document.activeElement;
      if (focused?.closest(".question-section") && focused.tagName === "INPUT")
        focused.addEventListener("blur", apply, { once: true });
      else apply();
    },
    onError: (m) => updateAI({ status: "error", message: m.message }),
  });
}
window.addEventListener("folio:interpreter-ready", () => {
  initInterpreter();
  if ($("#note").value.trim()) scheduleSemantic();
});
function updateAI(update) {
  state.ai = { ...state.ai, ...update };
  const b = $("#ai-status");
  if (!b) return;
  const status = state.ai.status;
  b.textContent =
    status === "loading"
      ? Number.isFinite(state.ai.progress)
        ? "Local AI · " + Math.round(state.ai.progress * 100) + "%"
        : "Loading local AI…"
      : status === "thinking"
        ? state.ai.message || "Reading the encounter…"
        : status === "ready"
          ? "Local AI ready"
          : status === "error"
            ? "Local AI needs attention ↗"
            : status === "paused"
              ? "Local AI paused"
              : "Local AI · starts with your note";
  b.dataset.status = status;
}
function scheduleSemantic() {
  clearTimeout(semanticTimer);
  const note = $("#note").value.trim();
  if (note.length < 8 || state.ai.status === "paused") return;
  semanticTimer = setTimeout(() => {
    initInterpreter();
    if (!interpreter) return;
    state.requestNote = $("#note").value.trim();
    state.requestEncounter = state.id;
    interpreter.analyze(
      state.requestNote,
      D.services.map((x) => ({ id: x.id, label: x.label })),
      A.serviceSeeds(state.requestNote, context(), D),
    );
  }, 700);
}
function build({ requestAI = true } = {}) {
  const note = $("#note").value.trim();
  if (!note && !state.manual.length) {
    state.result = null;
    state.facts = null;
    render();
    return;
  }
  try {
    state.clock ??= A.clock();
    state.savedOnly = false;
    state.reviewed = false;
    const start = performance.now();
    const suggestion = A.suggest(
      note,
      context(),
      D,
      state.clock,
      state.semantic,
    );
    state.facts = suggestion.facts;
    state.base = F.compile(
      state.facts,
      context(),
      D,
      state.ledger.filter((r) => r.encounterId !== state.id),
    );
    state.elapsed = performance.now() - start;
    state.dirty = false;
    applyItems();
    remember();
    render();
    renderSidebar();
    syncInputs();
    if (requestAI && !state.semantic) scheduleSemantic();
  } catch (e) {
    updateAI({ status: "error", message: e.message });
  }
}
function applyItems() {
  const r = structuredClone(state.base);
  r.items = r.items.filter((x) => !state.removed.includes(x.code));
  for (const m of state.manual) {
    const i = r.items.findIndex((x) => x.code === m.code);
    if (i >= 0) r.items[i] = { ...r.items[i], ...m };
    else r.items.push({ ...m });
  }
  const v = V.validateCodes(r.items, D, {
    role:
      state.facts?.role === "procedure_only" ? "operator" : state.facts?.role,
    ecgAllowed: PROFILE.ecgInterpretation,
  });
  r.blockers = [...new Set([...r.blockers, ...v.errors])];
  r.warnings = [...new Set([...r.warnings, ...v.warnings])];
  r.line = C.line(r.items);
  if (state.removed.length)
    r.excluded.push(
      ...state.removed.map((c) => c + ": removed from the draft by you."),
    );
  state.result = r;
}
function recompile() {
  build({ requestAI: false });
}
$("#build").onclick = () => build();
$("#note").oninput = () => {
  state.clock ??= A.clock();
  state.dirty = true;
  state.reviewed = false;
  state.savedOnly = false;
  state.semantic = null;
  state.ctx.careConfirmed = false;
  delete state.ctx.careEpisodes;
  interpreter?.cancel();
  clearTimeout(semanticTimer);
  clearTimeout(liveTimer);
  $("#note-count").textContent =
    $("#note").value.length.toLocaleString() + " characters · only in this tab";
  liveTimer = setTimeout(() => build(), 100);
};
$("#reference").oninput = () => {
  state.reviewed = false;
  remember();
  render();
};
for (const field of ["date", "time", "role", "payer", "pathway", "holiday"])
  $("#context-" + field).onchange = (e) => {
    state.ctx[field] =
      field === "holiday" ? e.target.checked : e.target.value || undefined;
    if (field === "date") state.ctx.dateConfirmed = !!state.ctx.date;
    state.reviewed = false;
    state.savedOnly = false;
    if ($("#note").value.trim() || state.manual.length) build();
  };
$("#clear-note").onclick = () => {
  if (!$("#note").value) return;
  modal(
    "Clear this note?",
    E("p", {
      text: "The raw note will be removed from this tab. Any saved billing draft stays in your shift.",
    }),
    E("button", {
      class: "button primary",
      text: "Clear note",
      onclick: () => {
        interpreter?.cancel();
        clearTimeout(semanticTimer);
        clearTimeout(liveTimer);
        state.semantic = null;
        state.clock = null;
        state.session.delete(state.id);
        $("#note").value = "";
        state.facts = null;
        state.result = null;
        state.base = null;
        state.ctx.overrides = {};
        delete state.ctx.careEpisodes;
        state.ctx.careConfirmed = false;
        state.manual = [];
        state.removed = [];
        state.dirty = false;
        state.reviewed = false;
        $("#modal").close();
        render();
      },
    }),
  );
};
$("#load-note").onclick = () => $("#note-file").click();
$("#note-file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (f.size > 140000) throw Error("Use one encounter under 140 KB.");
    remember();
    newEncounter();
    $("#note").value = await f.text();
    state.dirty = true;
    build();
    toast("Text imported. Suggestions are updating.");
  } catch (x) {
    toast(x.message);
  }
  e.target.value = "";
};
$("#show-codes").onchange = render;
function displayOption(v, q) {
  return q.field.endsWith(".actor") && v === "other"
    ? "Another physician"
    : labels[v] || String(v).replaceAll("_", " ");
}
function answer(q, value) {
  const field = q.field;
  let v = value;
  if (v === "") return toast("Enter the documented value.");
  if (["yes", "no"].includes(v)) v = v === "yes";
  if (field === "date") {
    const date = T.parseDate(v);
    if (!date) return toast("Use a valid calendar date.");
    state.ctx.date = typeof date === "string" ? date : date.date || v;
    state.ctx.dateConfirmed = true;
  } else if (field === "time") {
    const t = T.clock(v, { assume24: true });
    if (!t || t.ambiguous) return toast("Use a clear 24-hour time.");
    state.ctx.time = t.time;
  } else if (
    [
      "role",
      "payer",
      "pathway",
      "activationConfirmed",
      "tripId",
      "newTrip",
    ].includes(field)
  ) {
    state.ctx[field] = v;
    if (field === "activationConfirmed" && v === false) {
      state.ctx.pathway = "regular";
      state.facts.activation = "none";
    }
  } else if (field.startsWith("events.")) {
    const p = field.split("."),
      id = p[1];
    state.ctx.overrides.events ??= {};
    const ov = (state.ctx.overrides.events[id] ??= {});
    if (p[2] === "attrs") {
      ov.attrs ??= {};
      const k = p[3];
      if (["length_cm", "count", "complex_minutes"].includes(k)) {
        v = Number(v);
        if (!(v > 0 && v <= 200))
          return toast("Enter a positive measured value, at most 200.");
      }
      ov.attrs[k] = v;
      if (k === "documentation") {
        ov.attrs.saved_images = v === true;
        ov.attrs.report = v === true;
      }
      if (k === "new_application") ov.attrs.complete = v === true;
      if (k === "exact_code") ov.attrs.preamble_confirmed = false;
    } else {
      if (p[2] === "time") {
        const t = T.clock(v, { assume24: true });
        if (!t) return toast("Use a valid time.");
        v = t.time;
      }
      ov[p[2]] = v;
    }
  } else state.ctx.overrides[field] = v;
  if (field === "criticalTier" && v === "none")
    state.ctx.overrides.exclusive = false;
  syncInputs();
  recompile();
}
function questionCard(q, remaining = 0) {
  const card = E(
    "div",
    { class: "question-section" },
    E("div", { class: "question-label", text: "REFINE" }),
    E("h3", { text: q.text }),
  );
  const opts = E("div", { class: "options" });
  if (q.options?.length) {
    for (const v of q.options)
      opts.append(
        E("button", {
          class: "option",
          text: displayOption(v, q),
          onclick: () => answer(q, v),
        }),
      );
  } else {
    const type =
      q.field === "date"
        ? "date"
        : q.field.toLowerCase().endsWith("time")
          ? "time"
          : q.field.endsWith("length_cm")
            ? "number"
            : "text";
    const input = E("input", {
      type,
      "aria-label": q.text,
      placeholder: q.field.toLowerCase().includes("interval")
        ? "e.g. 00:05–00:21; 01:10–01:20"
        : "Documented value",
    });
    opts.append(
      input,
      E("button", {
        class: "option",
        text: "Apply",
        onclick: () => answer(q, input.value),
      }),
    );
    input.onkeydown = (e) => {
      if (e.key === "Enter") answer(q, input.value);
    };
  }
  card.append(opts);
  if (q.field.startsWith("events."))
    card.append(
      E("button", {
        class: "text-button",
        text: "Leave this service out",
        onclick: () => {
          const id = q.field.split(".")[1];
          state.ctx.overrides.events ??= {};
          state.ctx.overrides.events[id] ??= {};
          state.ctx.overrides.events[id].skipBilling = true;
          recompile();
        },
      }),
    );
  if (remaining)
    card.append(
      E("p", {
        class: "question-more",
        text:
          remaining +
          " more " +
          (remaining === 1 ? "detail" : "details") +
          " to resolve after this.",
      }),
    );
  return card;
}
function sourceNote() {
  return E(
    "div",
    { class: "source-note" },
    E("span", { text: "ⓘ" }),
    E("button", {
      text: "Rates not bundled · Check source coverage ↗",
      onclick: showSources,
    }),
  );
}
function editClock(field) {
  const current =
    state.facts?.[field] || state.clock?.[field] || A.clock()[field];
  const input = E("input", {
    type: field === "date" ? "date" : "time",
    value: current,
    "aria-label": field === "date" ? "Service date" : "Assessment time",
  });
  modal(
    field === "date" ? "Service date" : "Assessment time",
    input,
    E("button", {
      class: "button primary",
      text: "Use this",
      onclick: () => {
        state.ctx[field] = input.value;
        if (field === "date") state.ctx.dateConfirmed = true;
        $("#modal").close();
        build({ requestAI: false });
      },
    }),
  );
}
function editServiceTime(event) {
  const date = E("input", {
    type: "date",
    value: event.date || state.facts.date,
    "aria-label": "Procedure date",
  });
  const time = E("input", {
    type: "time",
    value: event.time || state.facts.time,
    "aria-label": "Procedure time",
  });
  modal(
    event.label + " · time",
    date,
    time,
    E("button", {
      class: "button primary",
      text: "Use this",
      onclick: () => {
        if (!date.value || !time.value) return;
        state.ctx.overrides.events ??= {};
        state.ctx.overrides.events[event.service] = {
          ...state.ctx.overrides.events[event.service],
          date: date.value,
          time: time.value,
        };
        $("#modal").close();
        build({ requestAI: false });
      },
    }),
  );
}
function renderQuickContext() {
  const now = state.clock || A.clock(),
    f = state.facts;
  $("#quick-context").replaceChildren(
    E("button", {
      class: "context-chip",
      text:
        (f?.date || now.date) +
        (f?.assumptions?.find((x) => x.field === "date")
          ? " · " + f.assumptions.find((x) => x.field === "date").source
          : !f
            ? " · today"
            : ""),
      onclick: () => editClock("date"),
    }),
    E("button", {
      class: "context-chip",
      text:
        (f?.time || now.time) +
        (f?.assumptions?.some((x) => x.field === "time") || !f ? " · now" : ""),
      onclick: () => editClock("time"),
    }),
    E("span", { class: "context-zone", text: "Toronto" }),
  );
}
function assessmentChoices() {
  const f = state.facts;
  if (!f || !["primary", "handover"].includes(f.role) || state.result?.critical)
    return null;
  const choices = E(
    "details",
    { class: "assessment-choices" },
    E("summary", { text: "Change assessment" }),
  );
  choices.append(
    E(
      "div",
      { class: "options" },
      ["minor", "multisystem", "comprehensive"].map((level) =>
        E("button", {
          class: "option " + (f.assessment?.level === level ? "selected" : ""),
          text:
            labels[level] +
            " · " +
            V.assessment(f.date, f.time, level, state.ctx.holiday) +
            (f.interpretation?.assessment?.level === level &&
            level !== f.assessment.level
              ? " · AI option"
              : ""),
          onclick: () => {
            state.ctx.overrides.level = level;
            build({ requestAI: false });
          },
        }),
      ),
    ),
  );
  return choices;
}
function editCareTimeline() {
  const plan = state.facts.carePlan;
  const rows = (plan?.episodes || []).map((e) => ({ ...e }));
  const list = E("div", { class: "care-editor" });
  const draw = () => {
    list.replaceChildren(
      ...rows.map((e, i) =>
        E(
          "div",
          { class: "care-edit-row" },
          E("input", {
            value: e.label,
            "aria-label": "Episode " + (i + 1),
            onchange: (x) => (e.label = x.target.value),
          }),
          E("input", {
            type: "time",
            value: e.start,
            "aria-label": "Start " + (i + 1),
            onchange: (x) => (e.start = x.target.value),
          }),
          E("input", {
            type: "time",
            value: e.end,
            "aria-label": "End " + (i + 1),
            onchange: (x) => (e.end = x.target.value),
          }),
          E(
            "select",
            {
              "aria-label": "Type " + (i + 1),
              onchange: (x) => (e.kind = x.target.value),
            },
            E("option", {
              value: "care",
              text: "Active care",
              selected: e.kind === "care" ? "" : null,
            }),
            E("option", {
              value: "excluded",
              text: "Exclude",
              selected: e.kind === "excluded" ? "" : null,
            }),
          ),
          E("button", {
            class: "text-button",
            text: "Remove",
            onclick: () => {
              rows.splice(i, 1);
              draw();
            },
          }),
        ),
      ),
    );
  };
  draw();
  modal(
    "Care timeline",
    E("p", {
      text: "Adjust the proposed blocks. Interruptions and separate procedures are subtracted automatically.",
    }),
    list,
    E("button", {
      class: "text-button",
      text: "+ Add a block",
      onclick: () => {
        const start = rows.at(-1)?.end || state.facts.time;
        rows.push({
          label: "Active care",
          start,
          end: start,
          kind: "care",
          quote: "",
          timing: "confirmed",
        });
        draw();
      },
    }),
    E("button", {
      class: "button primary",
      text: "Use this timeline",
      onclick: () => {
        if (rows.some((e) => !e.start || !e.end || e.start === e.end))
          return toast("Each block needs a start and a later end.");
        state.ctx.careEpisodes = rows;
        state.ctx.careConfirmed = true;
        state.ctx.overrides.exclusive = true;
        state.ctx.overrides.criticalTier = plan.tier;
        $("#modal").close();
        build({ requestAI: false });
      },
    }),
  );
}
function carePanel() {
  const p = state.facts?.carePlan;
  if (!p?.minutes) return null;
  return E(
    "section",
    { class: "care-panel", "aria-label": "Care reconstruction" },
    E(
      "div",
      { class: "care-heading" },
      E("strong", { text: p.minutes + " min active care" }),
      E("span", {
        class: "tag " + (p.basis === "estimated" ? "amber" : "blue"),
        text:
          p.basis === "estimated"
            ? "Estimated timeline"
            : p.confirmed
              ? "Times confirmed"
              : "Times from note",
      }),
    ),
    E("p", { text: p.reason }),
    E(
      "div",
      { class: "care-timeline" },
      p.episodes.map((e) =>
        E(
          "div",
          { class: "care-episode " + e.kind },
          E("span", { class: "care-clock", text: e.start + "–" + e.end }),
          E("span", { text: e.label }),
          E("small", {
            text:
              e.kind === "excluded"
                ? "Excluded"
                : e.timing === "estimated"
                  ? "Estimated"
                  : "",
          }),
        ),
      ),
    ),
    p.excludedMinutes
      ? E("p", {
          class: "care-note",
          text:
            p.excludedMinutes +
            " min removed · overlapping blocks counted once",
        })
      : null,
    p.basis === "estimated"
      ? E("p", {
          class: "care-note",
          text: "Suggested active-care time from the work described. Adjust it to match your care.",
        })
      : null,
    E(
      "div",
      { class: "care-actions" },
      !p.confirmed
        ? E("button", {
            class: "button primary",
            text: "These times fit my care",
            onclick: () => {
              // Keep the confirmed clocks fixed if the encounter clock changes.
              state.ctx.careEpisodes = p.episodes.map((e) => ({ ...e }));
              state.ctx.careConfirmed = true;
              build({ requestAI: false });
            },
          })
        : null,
      E("button", {
        class: "text-button",
        text: "Adjust timeline",
        onclick: editCareTimeline,
      }),
      E("button", {
        class: "text-button",
        text: "Use assessment instead",
        onclick: () => {
          state.ctx.overrides.criticalTier = "none";
          build({ requestAI: false });
        },
      }),
    ),
  );
}
function documentationPanel() {
  const text = FolioCare.documentation(state.facts);
  if (!text) return null;
  const area = E("textarea", {
    class: "documentation-draft",
    value: text,
    "aria-label": "Suggested chart wording",
  });
  return E(
    "details",
    { class: "documentation-panel" },
    E("summary", { text: "Suggested chart wording" }),
    E("p", { text: "Edit this draft to match the work you performed." }),
    area,
    E("button", {
      class: "text-button",
      text: "Copy wording",
      onclick: () => copyText(area.value, "Chart wording copied."),
    }),
  );
}
function render() {
  const box = $("#draft-content"),
    n = $("#note").value.length;
  $("#note-count").textContent = n
    ? n.toLocaleString() + " characters · only in this tab"
    : "Your note stays in this tab.";
  renderQuickContext();
  box.replaceChildren();
  if (!state.result) {
    box.append(
      E(
        "div",
        { class: "empty-draft" },
        E("div", { class: "empty-symbol", text: "≡" }),
        E("h3", { text: "Start typing" }),
        E("p", { text: "Your suggested bill will appear here." }),
        E("button", {
          class: "button secondary",
          text: "Find a code →",
          onclick: () => {
            navigate("library");
            $("#query").focus();
          },
        }),
      ),
      sourceNote(),
    );
    return;
  }
  const r = state.result,
    f = state.facts,
    questions = r.questions || [];
  box.append(
    E(
      "div",
      { class: "draft-meta" },
      E("span", {
        class: "tag " + (r.blockers.length ? "red" : "blue"),
        text: r.blockers.length
          ? "Combination to resolve"
          : state.savedOnly
            ? "Saved draft"
            : "Suggested bill",
      }),
      state.semantic
        ? E("span", { class: "tag", text: "AI interpreted" })
        : null,
    ),
  );
  if (state.savedOnly)
    box.append(
      E("div", {
        class: "source-note",
        text:
          "Saved codes" +
          (r.criticalProposed ? " · timing remains proposed" : "") +
          ". Paste the note to reinterpret this encounter.",
      }),
    );
  if (!state.savedOnly) {
    const care = carePanel();
    if (care) box.append(care);
  }
  for (const [i, x] of r.items.entries()) {
    const c = D.codes.find((c) => c.code === x.code),
      isAssessment =
        f?.assessment?.level &&
        !r.critical &&
        ["primary", "handover"].includes(f?.role) &&
        x.code ===
          V.assessment(f.date, f.time, f.assessment.level, state.ctx.holiday);
    box.append(
      E(
        "div",
        { class: "service-row " + (isAssessment ? "lead-service" : "") },
        E(
          "div",
          { class: "service-body" },
          E("strong", {
            text: isAssessment
              ? labels[f.assessment.level]
              : c?.label || x.reason || x.code,
          }),
          E("small", {
            text: isAssessment
              ? f.assessment.reason || "Matched to the encounter and time band."
              : r.critical && /^G(?:521|523|522|395|391)$/.test(x.code)
                ? r.criticalTimeBasis === "estimated"
                  ? "From the proposed care timeline"
                  : "From the care timeline"
                : x.timeUnits
                  ? x.timeUnits + " time units"
                  : x.units > 1
                    ? x.units + " units"
                    : x.manual
                      ? "Added by you"
                      : x.reason || "Saved draft",
          }),
        ),
        E("button", {
          class: $("#show-codes").checked ? "code-chip" : "text-button",
          text: $("#show-codes").checked
            ? x.code + (x.units > 1 ? " ×" + x.units : "")
            : "Details ↗",
          onclick: () => showCode(x.code, x),
        }),
      ),
    );
  }
  const choices = assessmentChoices();
  if (choices && !state.savedOnly) box.append(choices);
  if (!r.items.length)
    box.append(
      E("p", {
        class: "no-candidate",
        text: "The services below need a little more detail.",
      }),
    );
  for (const b of r.blockers) box.append(E("div", { class: "alert", text: b }));
  // Significant uncertainties refine the suggestion; they do not hide the rest of the bill.
  if (questions.length && !state.savedOnly) {
    const refining =
      !state.semantic && !["error", "paused"].includes(state.ai.status);
    box.append(
      refining
        ? E(
            "details",
            { class: "assessment-choices" },
            E("summary", { text: "Refine details" }),
            questionCard(questions[0], questions.length - 1),
          )
        : questionCard(questions[0], questions.length - 1),
    );
  }
  const model = state.semantic
    ? A.validate(state.semantic, $("#note").value.trim(), D).value
    : null;
  if (model?.work?.length)
    box.append(
      E(
        "div",
        { class: "understood-work" },
        E("div", { class: "section-caption", text: "Work recognized" }),
        E(
          "div",
          { class: "work-chips" },
          model.work.map((w) =>
            E("button", {
              class: "work-chip " + w.certainty,
              text:
                w.label +
                (w.certainty === "documented" ? "" : " · " + w.certainty),
              onclick: () =>
                modal(
                  w.label,
                  E("span", { class: "tag", text: w.certainty }),
                  E("blockquote", { text: w.quote }),
                ),
            }),
          ),
        ),
      ),
    );
  const opportunities = [
    ...(model?.opportunities || []).map((o) => ({
      ...o,
      detail: o.detail,
      model: true,
    })),
    ...(r.opportunities || []),
  ]
    .filter((o) => !(r.critical && o.pathway?.startsWith("critical_")))
    .filter((o, i, a) => a.findIndex((x) => x.title === o.title) === i);
  if (opportunities.length && !state.savedOnly) {
    const area = E(
      "div",
      { class: "opportunity-area" },
      E("div", { class: "section-caption", text: "Additional capture" }),
    );
    for (const o of opportunities.slice(0, 3))
      area.append(
        E(
          "div",
          { class: "capture-card" },
          E("h3", { text: o.title }),
          E("p", { text: o.detail }),
          o.pathway?.startsWith("critical_") && !r.critical
            ? E("button", {
                class: "text-button",
                text: "Use care option →",
                onclick: () => {
                  state.ctx.overrides.criticalTier =
                    o.pathway === "critical_life" ? "life" : "other";
                  build({ requestAI: false });
                },
              })
            : null,
          o.question
            ? questionCard(o.question)
            : o.quote
              ? E(
                  "details",
                  {},
                  E("summary", { text: "Why" }),
                  E("blockquote", { text: o.quote }),
                )
              : null,
        ),
      );
    box.append(area);
  }
  if (!state.savedOnly) {
    const doc = documentationPanel();
    if (doc) box.append(doc);
  }
  const evidence = E(
    "details",
    {},
    E("summary", { text: "Evidence & checks" }),
  );
  for (const ev of f?.events || [])
    evidence.append(
      E("h4", {
        text:
          ev.label +
          " · " +
          ev.status +
          " · " +
          (ev.actor === "other" ? "another physician" : ev.actor),
      }),
      E("blockquote", { text: ev.evidence }),
      ev.timeAssumed
        ? E("button", {
            class: "text-button",
            text: "Time: " + ev.time + " · from encounter · edit",
            onclick: () => editServiceTime(ev),
          })
        : ev.time
          ? E("button", {
              class: "text-button",
              text: "Time: " + ev.time + " · edit",
              onclick: () => editServiceTime(ev),
            })
          : null,
    );
  for (const text of [...(r.excluded || []), ...(r.warnings || [])])
    evidence.append(E("div", { class: "small-row", text }));
  const valid = r.items.length > 0 && !r.blockers.length;
  evidence.append(
    E(
      "label",
      { class: "review-check" },
      E("input", {
        type: "checkbox",
        checked: state.reviewed,
        disabled: !valid || questions.length > 0,
        "aria-label": "Mark this draft reviewed",
        onchange: (e) => {
          state.reviewed = e.target.checked;
        },
      }),
      "Mark this draft reviewed",
    ),
  );
  box.append(
    E("div", { class: "review-section" }, evidence),
    E(
      "div",
      { class: "draft-actions" },
      E(
        "div",
        { class: "action-row" },
        E("button", {
          class: "button primary",
          text: "Copy codes",
          disabled: !valid,
          onclick: () => copyText(r.line),
        }),
        E("button", {
          class: "button secondary",
          text: "Save draft",
          disabled: !r.items.length,
          onclick: saveEncounter,
        }),
        E("button", {
          class: "text-button",
          text: "＋ Add a code",
          onclick: () => {
            navigate("library");
            $("#query").focus();
          },
        }),
      ),
    ),
    sourceNote(),
  );
}
function saveEncounter() {
  if (!state.result?.items.length) return;
  let ref = $("#reference").value.trim();
  if (!ref) {
    ref = defaultReference();
    $("#reference").value = ref;
  }
  if (state.result.blockers.length && state.reviewed) {
    toast("Resolve the conflicting codes before marking this reviewed.");
    return;
  }
  if (state.savedOnly) {
    const prior = state.ledger.find((r) => r.encounterId === state.id);
    if (!prior) return;
    const updated = C.cleanRow(
      { ...prior, reference: ref, reviewed: state.reviewed },
      D,
    );
    state.ledger = C.mergeRows(state.ledger, [updated]);
    if (persist()) toast("Draft updated.");
    renderSidebar();
    return;
  }
  const f = state.facts,
    r = state.result;
  const row = C.cleanRow(
    {
      encounterId: state.id,
      reference: ref,
      date: f?.date || null,
      time: f?.time || null,
      payer: f?.payer || "unknown",
      role: f?.role || "primary",
      codes: r.items.map((x) => ({
        code: x.code,
        units: x.units || 1,
        timeUnits: x.timeUnits,
      })),
      criticalMinutes: r.criticalMinutes,
      ruleVersion: window.FOLIO_SOURCES?.version,
      criticalTimeBasis: r.criticalTimeBasis,
      criticalProposed: r.criticalProposed,
      criticalIntervals: r.criticalIntervals || [],
      periodKey: r.period?.key,
      specialVisit: !!r.period?.patientCode,
      tripId: state.ctx.tripId,
      travelClaimed: r.items.some((x) => /^H96\d$/.test(x.code)),
      reviewed: state.reviewed && !r.questions.length && !r.blockers.length,
      savedAt: new Date().toISOString(),
    },
    D,
  );
  state.ledger = C.mergeRows(state.ledger, [row]);
  remember();
  const durable = persist();
  renderSidebar();
  if (durable)
    toast(
      (row.reviewed ? "Reviewed draft saved" : "Saved for review") +
        " · raw note not stored.",
    );
}
function workingRows() {
  const rows = [...state.ledger];
  for (const [id, m] of state.session)
    if (!rows.some((r) => r.encounterId === id))
      rows.push({
        encounterId: id,
        reference: m.reference || "Untitled encounter",
        time: m.time || m.ctx.time,
        reviewed: false,
        unsaved: true,
      });
  return rows;
}
function renderSidebar() {
  $("#shift-count").textContent = state.ledger.length;
  $("#shift-name").textContent = state.shiftName;
  $("#encounter-list").replaceChildren(
    ...(workingRows().length
      ? workingRows()
          .slice()
          .reverse()
          .slice(0, 15)
          .map((r) =>
            E(
              "button",
              {
                class:
                  "encounter-row " +
                  (r.encounterId === state.id ? "current" : ""),
                onclick: () => openEncounter(r.encounterId),
              },
              E("span", { class: "row-icon", text: r.reviewed ? "✓" : "·" }),
              E(
                "div",
                {},
                E("strong", { text: r.reference }),
                E("small", {
                  text:
                    (r.time || "Time to check") +
                    " · " +
                    (r.unsaved
                      ? "In this tab"
                      : r.reviewed
                        ? "Reviewed draft"
                        : "Needs review"),
                }),
              ),
            ),
          )
      : [E("div", { class: "sidebar-empty", text: "No saved encounters." })]),
  );
}
function openEncounter(id) {
  interpreter?.cancel();
  clearTimeout(semanticTimer);
  clearTimeout(liveTimer);
  remember();
  state.semantic = null;
  state.clock = null;
  const memo = state.session.get(id);
  const row =
    state.ledger.find((x) => x.encounterId === id) ||
    (memo
      ? { encounterId: id, reference: memo.reference, reviewed: false }
      : null);
  if (!row) return;
  Object.assign(state, {
    id,
    ctx: { overrides: {} },
    facts: null,
    result: null,
    base: null,
    manual: [],
    removed: [],
    reviewed: row.reviewed,
    dirty: false,
    savedOnly: !memo,
  });
  $("#reference").value = row.reference;
  $("#note").value = memo?.note || "";
  if (memo) {
    state.clock = memo.clock;
    state.semantic = memo.semantic || null;
    state.semanticMs = memo.semanticMs;
    state.ctx = structuredClone(memo.ctx);
    state.manual = structuredClone(memo.manual);
    state.removed = [...memo.removed];
    build();
    state.reviewed = row.reviewed;
  } else {
    state.ctx = {
      overrides: {},
      date: row.date,
      dateConfirmed: !!row.date,
      time: row.time,
      role: row.role,
      payer: row.payer,
    };
    state.facts = {
      date: row.date,
      time: row.time,
      role: row.role,
      payer: row.payer,
      events: [],
    };
    const v = V.validateCodes(row.codes, D, {
      role: row.role,
      ecgAllowed: PROFILE.ecgInterpretation,
    });
    state.result = {
      items: row.codes,
      line: C.line(row.codes),
      questions: row.reviewed
        ? []
        : [
            {
              id: "restore",
              text: "Reopen the source note to resolve the original missing facts.",
            },
          ],
      blockers: v.errors,
      warnings: v.warnings,
      excluded: [],
      opportunities: [],
      criticalMinutes: row.criticalMinutes,
      criticalTimeBasis: row.criticalTimeBasis,
      criticalProposed: row.criticalProposed,
      criticalIntervals: row.criticalIntervals,
    };
  }
  syncInputs();
  render();
  renderSidebar();
  navigate("build");
}
function renderShift() {
  const rows = state.ledger;
  $("#shift-stats").replaceChildren(
    ...[
      [rows.length, "Encounters saved"],
      [rows.filter((r) => r.reviewed).length, "Reviewed drafts"],
      [rows.filter((r) => !r.reviewed).length, "Need your attention"],
    ].map(([n, t]) =>
      E(
        "div",
        { class: "stat" },
        E("strong", { text: n }),
        E("span", { text: t }),
      ),
    ),
  );
  const target = $("#shift-table");
  const unsaved = workingRows().filter((r) => r.unsaved);
  const working = E(
    "div",
    { class: "working-drafts" },
    ...unsaved.map((r) =>
      E("button", {
        class: "text-button",
        text: r.reference + " · in this tab →",
        onclick: () => openEncounter(r.encounterId),
      }),
    ),
  );
  if (!rows.length) {
    target.replaceChildren(
      working,
      E(
        "div",
        { class: "table-empty" },
        E("h3", { text: "No saved encounters" }),
        E("p", { text: "Save a draft to start your shift." }),
        E("button", {
          class: "button primary",
          text: "Build a bill →",
          onclick: () => navigate("build"),
        }),
      ),
    );
    return;
  }
  const table = E(
    "table",
    {},
    E(
      "thead",
      {},
      E(
        "tr",
        {},
        ["Encounter", "When", "Codes", "Status", ""].map((t) =>
          E("th", { text: t }),
        ),
      ),
    ),
  );
  const body = E("tbody");
  for (const r of rows)
    body.append(
      E(
        "tr",
        {},
        E(
          "td",
          {},
          E("button", {
            class: "text-button",
            text: r.reference,
            onclick: () => openEncounter(r.encounterId),
          }),
          E("small", { text: labels[r.payer] || r.payer }),
        ),
        E(
          "td",
          { text: r.date || "Date to check" },
          E("small", { text: r.time || "Time to check" }),
        ),
        E("td", {}, E("code", { text: C.line(r.codes) })),
        E(
          "td",
          {},
          E("span", {
            class: "tag " + (r.reviewed ? "blue" : "amber"),
            text: r.criticalProposed
              ? "Proposed timing"
              : r.reviewed
                ? "Reviewed draft"
                : "Draft",
          }),
        ),
        E(
          "td",
          {},
          E("button", {
            class: "text-button",
            text: "Remove",
            "aria-label": "Remove " + r.reference,
            onclick: () => removeEncounter(r),
          }),
        ),
      ),
    );
  table.append(body);
  target.replaceChildren(working, table);
}
function removeEncounter(r) {
  modal(
    "Remove " + r.reference + "?",
    E("p", {
      text: "This removes its saved billing draft from this device. You can restore it from a JSON backup.",
    }),
    E("button", {
      class: "button primary",
      text: "Remove encounter",
      onclick: () => {
        state.ledger = state.ledger.filter(
          (x) => x.encounterId !== r.encounterId,
        );
        persist();
        renderSidebar();
        renderShift();
        $("#modal").close();
        toast("Encounter removed from shift.");
      },
    }),
  );
}
function sourceNodes(ids) {
  return [...new Set(ids)].map((id) => {
    const s = D.sources.find((x) => x.id === id);
    if (!s)
      return E("p", {
        class: "source",
        text: id + " · source record unavailable",
      });
    let href;
    try {
      const url = new URL(s.url);
      if (["http:", "https:"].includes(url.protocol)) href = url.href;
    } catch {}
    return E(
      "div",
      { class: "source" },
      E("strong", { text: s.title || id }),
      E("p", { text: s.review || s.status || s.note || "" }),
      href
        ? E("a", {
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            text: "Open source ↗",
          })
        : null,
    );
  });
}
function guidanceNodes(ruleId) {
  const bundle = window.FOLIO_SOURCES;
  if (!bundle) return [];
  const keys = ruleId
    ? bundle.ruleEvidence[ruleId] || []
    : bundle.sources.map((s) => s.key);
  return keys.map((key) => {
    const s = bundle.sources.find((s) => s.key === key);
    return E(
      "div",
      { class: "source" },
      E("strong", { text: s.title }),
      E("p", { text: s.summary }),
      E("blockquote", { text: s.quote }),
      E("a", {
        href: s.url,
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Read Ontario guidance ↗",
      }),
      E("small", {
        text: "Checked " + s.checkedOn + " · " + s.locator + " · " + s.unitId,
      }),
    );
  });
}
function ruleNode(id) {
  const r = D.rules.find((x) => x.id === id);
  if (!r) return E("p", { text: id });
  return E(
    "div",
    { class: "rule" },
    E("h3", { text: r.title }),
    E("span", {
      class: "tag",
      text: r.id + " · " + r.review_status.replaceAll("_", " "),
    }),
    E("p", { text: r.body }),
    ...guidanceNodes(r.id),
    ...sourceNodes(r.source_ids || []),
  );
}
function showSources() {
  modal(
    "Sources & coverage",
    E("p", {
      text:
        D.codes.length +
        " code entries, " +
        D.services.length +
        " service concepts and " +
        D.rules.length +
        " rule cards from your FastBill v3 package.",
    }),
    E("p", {
      text: "A local language model interprets the encounter and suggests additional work. The supplied FastBill rules map recognized services to this focused ED billing catalogue. Source status remains visible on each rule.",
    }),
    E("div", { class: "alert", text: D.metadata.source_note }),
    E("p", {
      text: "No current dollar fees are bundled. The app does not estimate revenue or submit claims. The ECG profile is currently set to CVH (G313 disabled). Source and effective-date details are preserved on each rule.",
    }),
    E("p", { text: window.FOLIO_SOURCES?.coverage || "" }),
    ...guidanceNodes(),
    ...sourceNodes(D.sources.map((x) => x.id)),
  );
}
$("#source-library").onclick = showSources;
$("#mobile-sources").onclick = showSources;
function privacy() {
  modal(
    "Storage & privacy",
    E("p", {
      text: "Clinical text is interpreted on this device. A Qwen3.5 4B model runs in a background browser worker; notes are never sent to a billing server, analytics service or AI provider. The first use downloads model files from Hugging Face and the WebLLM project, then caches them in this browser. Local AI requires WebGPU; immediate billing suggestions remain available while it loads or if it is unavailable.",
    }),
    E("h3", { text: "Only in this tab" }),
    E("p", {
      text: "Raw notes, quoted evidence and extraction details stay in memory. Refreshing or closing the tab clears them. Switching between encounters in the same tab keeps your working notes available.",
    }),
    E("h3", { text: "Saved on this device" }),
    E("p", {
      text: "When you save a draft, Folio stores the encounter reference, codes, service date and time, coverage, role, review status and critical-care intervals in browser local storage. This is not encrypted by Folio. Use non-identifying references and a trusted device.",
    }),
    E("h3", { text: "Recovery and export" }),
    E("p", {
      text: "Your shift survives a refresh on the same browser and site. JSON backups let you restore it elsewhere; CSV and print exports support review. Clearing browser data removes saved drafts. No cloud sync is connected.",
    }),
  );
}
$("#privacy").onclick = privacy;
$("#privacy-inline").onclick = privacy;
function showCode(code, item) {
  const c = D.codes.find((x) => x.code === code);
  if (!c) return;
  const nodes = [
    E("span", {
      class: "tag amber",
      text: (c.status || "Needs review").replaceAll("_", " "),
    }),
    E("p", {
      text: c.warning || "Verify current service-date requirements before use.",
    }),
    item?.reason ? E("p", { text: item.reason }) : null,
    item?.evidence ? E("blockquote", { text: item.evidence }) : null,
    E("p", {
      class: "muted",
      text:
        "Current fee: not bundled · Last package check: " +
        (c.checked_on || D.metadata.built_on),
    }),
    E("button", {
      class: "button primary",
      text: item ? "Edit this draft line" : "Add to my draft",
      onclick: () => manualDialog(c, item),
    }),
    ...(c.rule_ids || []).map(ruleNode),
  ];
  modal(code + " · " + c.label, ...nodes);
}
function manualDialog(c, item) {
  if (state.savedOnly) {
    modal(
      "Reopen the encounter note",
      E("p", {
        text: "This saved draft has no clinical note or quoted evidence. Paste the source note and build it again before changing the services.",
      }),
      E("button", {
        class: "button primary",
        text: "Return to encounter",
        onclick: () => {
          $("#modal").close();
          navigate("build");
          $("#note").focus();
        },
      }),
    );
    return;
  }
  const units = E("input", {
    type: "number",
    min: 1,
    max: 999,
    step: 1,
    value: item?.units || 1,
  });
  modal(
    c.code + " · " + c.label,
    E("p", {
      text: "Add this service to the draft. Adjust the units below.",
    }),
    E("label", { text: "Units" }, units),
    E("button", {
      class: "button primary",
      text: item ? "Update line" : "Add candidate",
      onclick: () => {
        const value = Number(units.value);
        if (!Number.isInteger(value) || value < 1 || value > 999)
          return toast("Use whole units from 1 to 999.");
        state.manual = state.manual.filter((x) => x.code !== c.code);
        state.manual.push({
          code: c.code,
          units: value,
          manual: true,
          reason: "Added by you",
          rule_ids: c.rule_ids,
        });
        state.removed = state.removed.filter((x) => x !== c.code);
        $("#modal").close();
        navigate("build");
        build();
      },
    }),
    item
      ? E("button", {
          class: "text-button",
          text: "Remove this line",
          onclick: () => {
            state.manual = state.manual.filter((x) => x.code !== c.code);
            state.removed.push(c.code);
            state.reviewed = false;
            applyItems();
            $("#modal").close();
            render();
          },
        })
      : null,
  );
}
function search() {
  const q = $("#query").value.trim(),
    hits = C.search(q, D, F);
  $("#result-count").textContent =
    hits.length + " " + (q ? "matches" : "codes in your library");
  const target = $("#search-results");
  target.replaceChildren();
  if (!hits.length) {
    target.append(
      E(
        "div",
        { class: "table-empty" },
        E("h3", { text: "No match in this library yet." }),
        E("p", {
          text: "Try a shorter procedure name or an exact code. This library covers selected emergency medicine services.",
        }),
        E("button", {
          class: "button secondary",
          text: "Browse all codes",
          onclick: () => {
            $("#query").value = "";
            search();
          },
        }),
      ),
    );
    return;
  }
  for (const h of hits) {
    const code =
      h.kind === "code" ? D.codes.find((c) => c.code === h.id) : null;
    const service =
      h.kind === "service" ? D.services.find((s) => s.id === h.id) : null;
    target.append(
      E(
        "article",
        { class: "search-result" },
        E("span", {
          class: "result-symbol",
          text: h.kind === "rule" ? "≡" : h.kind === "code" ? "#" : "↗",
        }),
        E(
          "div",
          { class: "result-body" },
          E("div", {
            class: "kind",
            text:
              h.kind === "service"
                ? "SERVICE CONCEPT"
                : h.kind === "rule"
                  ? "PAYMENT RULE"
                  : "FEE CODE",
          }),
          E("h3", { text: code ? code.label : h.title }),
          E("p", {
            text:
              h.kind === "rule"
                ? h.body.slice(0, 240) + (h.body.length > 240 ? "…" : "")
                : service
                  ? "Also found as: " + service.aliases.slice(0, 6).join(" · ")
                  : code?.warning || "Review the source requirements.",
          }),
          E(
            "div",
            { class: "code-tags" },
            (h.codes || []).map((c) =>
              E("button", {
                class: "code-chip",
                text: c,
                onclick: () => showCode(c),
              }),
            ),
          ),
        ),
        E("button", {
          class: "text-button",
          text: "Details ↗",
          onclick: () => {
            if (h.kind === "code") showCode(h.id);
            else if (h.kind === "rule") modal(h.title, ruleNode(h.id));
            else
              modal(
                h.title,
                E("p", {
                  text: "Related codes are alternatives to review, not a combined bill.",
                }),
                E(
                  "div",
                  { class: "options" },
                  h.codes.map((c) =>
                    E("button", {
                      class: "code-chip",
                      text: c,
                      onclick: () => showCode(c),
                    }),
                  ),
                ),
                ...(h.rule_ids || []).map(ruleNode),
              );
          },
        }),
      ),
    );
  }
}
$("#query").oninput = search;
$$("[data-search]").forEach(
  (b) =>
    (b.onclick = () => {
      $("#query").value = b.dataset.search;
      search();
    }),
);
async function copyText(t, message = "Draft codes copied.") {
  try {
    await navigator.clipboard.writeText(t);
    toast(message);
  } catch {
    const area = E("textarea", { readonly: "", value: t });
    modal(
      "Copy draft codes",
      E("p", {
        text: "Clipboard access is unavailable. Select and copy this text.",
      }),
      area,
    );
    area.select();
  }
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = E("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$("#export-csv").onclick = () => {
  if (!state.ledger.length) return toast("Save an encounter first.");
  download(
    "Folio_shift_DRAFT.csv",
    C.csv(state.ledger),
    "text/csv;charset=utf-8",
  );
  toast("CSV exported, with review status for every encounter.");
};
$("#export-json").onclick = () => {
  if (!state.ledger.length) return toast("Save an encounter first.");
  download(
    "Folio_shift_backup.json",
    JSON.stringify(
      { version: 1, shiftName: state.shiftName, ledger: state.ledger },
      null,
      2,
    ),
    "application/json",
  );
};
$("#import-json").onclick = () => $("#backup-file").click();
$("#backup-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2e6) throw Error("Backup is too large (2 MB maximum).");
    const data = C.importBackup(JSON.parse(await file.text()), D);
    modal(
      "Restore " + data.ledger.length + " encounters?",
      E("p", {
        text: "Records with the same encounter ID will be replaced by this backup. Other saved encounters are kept.",
      }),
      E("button", {
        class: "button primary",
        text: "Restore backup",
        onclick: () => {
          state.ledger = C.mergeRows(state.ledger, data.ledger);
          state.shiftName = data.shiftName;
          persist();
          renderSidebar();
          renderShift();
          $("#modal").close();
          toast("Backup restored. Raw notes are not included in backups.");
        },
      }),
    );
  } catch (x) {
    toast("Backup not imported: " + x.message);
  }
  e.target.value = "";
};
$("#print-shift").onclick = () => window.print();
$("#shift-settings").onclick = () => {
  const input = E("input", {
    value: state.shiftName,
    maxlength: 80,
    "aria-label": "Shift name",
  });
  const trip = E("input", {
    value: state.ctx.tripId || "",
    maxlength: 80,
    "aria-label": "Special visit trip reference",
  });
  const journey = E("input", {
    type: "checkbox",
    checked: !!state.ctx.newTrip,
  });
  modal(
    "Shift details",
    E("label", { text: "Shift name" }, input),
    E("h3", { text: "Special-visit travel, if applicable" }),
    E("p", {
      class: "muted",
      text: "Use encounter context to select the special-visit pathway. Claim travel only for an actual eligible journey.",
    }),
    E("label", { text: "Trip reference" }, trip),
    E(
      "label",
      { class: "check-label" },
      journey,
      "This encounter includes a separate eligible journey.",
    ),
    E("button", {
      class: "button primary",
      text: "Save details",
      onclick: () => {
        state.shiftName = input.value.trim() || "My shift";
        state.ctx.tripId = trip.value.trim();
        state.ctx.newTrip = journey.checked;
        persist();
        renderSidebar();
        if (state.facts && !state.savedOnly) recompile();
        $("#modal").close();
      },
    }),
  );
};
const demos = {
  reduction:
    "PIA: 30/08/26 2232\nSYNTHETIC CASE — 8F, fall onto left wrist. Displaced distal radial metaphyseal fracture. No head injury.\nComprehensive assessment and care completed: history, systems review, neurovascular and trauma examination, imaging and treatment response.\nI personally performed closed reduction under ketamine procedural sedation. Procedure started 23:10. Another physician provided sedation.\nVolar forearm slab applied. Post-reduction films acceptable. Neurovascular status intact. Discharged to fracture clinic.",
  critical:
    "PIA: 28/08/26 00:05\nSYNTHETIC CASE — acute respiratory failure from severe bronchospasm. I initiated BiPAP and titrated ventilatory support with repeated airway assessment.\nLife-threatening critical care; exclusive physician care, excluding procedures and care for other patients.\nCritical care 00:05–00:21; 01:10–01:20; 01:40–01:47.\nNursing inserted the IV. Work of breathing improved after treatment. Monitored admission.",
  declined:
    "PIA: 2026-09-18 16:50\nSYNTHETIC CASE — minor assessment of a small abscess.\nIncision and drainage offered; patient declined. No procedure was performed.\nNo critical care provided. Note signed 19:00.",
};
$$("[data-demo]").forEach(
  (b) =>
    (b.onclick = () => {
      newEncounter();
      $("#note").value = demos[b.dataset.demo];
      $("#reference").value =
        "Example · " +
        {
          reduction: "wrist",
          critical: "resuscitation",
          declined: "declined procedure",
        }[b.dataset.demo];
      build();
    }),
);
document.addEventListener("keydown", (e) => {
  if ($("#modal").open) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    build();
  }
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    navigate("library");
    $("#query").focus();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (
    $("#note").value.trim() &&
    !state.ledger.some((r) => r.encounterId === state.id)
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  try {
    const data = e.newValue
      ? C.importBackup(JSON.parse(e.newValue), D)
      : { ledger: [], shiftName: "My shift" };
    state.ledger = data.ledger;
    state.shiftName = data.shiftName;
    renderSidebar();
    if (state.page === "shift") renderShift();
    if (state.facts && !state.savedOnly) recompile();
    toast("Shift updated from another tab.");
  } catch {
    toast("Could not read the shift update from another tab.");
  }
});
initInterpreter();
syncInputs();
render();
renderSidebar();
navigate(location.hash.slice(1) || "build");

// Preserve access to the former app's local queue without trusting its old codes.
try {
  const legacy = JSON.parse(localStorage.getItem("billing_queue") || "[]");
  if (Array.isArray(legacy) && legacy.length) {
    const button = E("button", {
      class: "text-button",
      text: "Previous app data",
    });
    document.querySelector(".shift-toolbar > div").append(button);
    button.onclick = () =>
      modal(
        "Previous app data",
        E("p", {
          text: "The previous app stored notes in this browser. Those records have been preserved. Open a note to build a new draft, or download the original queue. Old codes are not automatically marked reviewed.",
        }),
        E("button", {
          class: "button secondary",
          text: "Export original queue",
          onclick: () =>
            download(
              "OHIP_previous_queue.json",
              JSON.stringify(legacy, null, 2),
              "application/json",
            ),
        }),
        ...legacy.slice(0, 1000).map((row, i) =>
          E(
            "div",
            { class: "rule" },
            E("strong", { text: "Previous encounter " + (i + 1) }),
            E("button", {
              class: "text-button",
              text: "Open note →",
              disabled: typeof row?.case !== "string",
              onclick: () => {
                newEncounter();
                $("#note").value = row.case.slice(0, 100000);
                $("#reference").value = "Previous encounter " + (i + 1);
                state.dirty = true;
                $("#modal").close();
                render();
              },
            }),
          ),
        ),
      );
  }
} catch {
  /* Malformed legacy records remain untouched. */
}

$("#ai-status").onclick = () =>
  modal(
    "On-device interpretation",
    E("p", {
      text:
        (state.ai.message ||
          "The model loads automatically with your first note.") +
        (state.semanticMs
          ? " · Last interpretation " +
            (state.semanticMs / 1000).toFixed(1) +
            " s"
          : ""),
    }),
    E("p", {
      text: "Qwen3.5 4B runs in a background worker on your device. The first use downloads its model files; later visits use the browser cache. Your note is never sent to a model provider.",
    }),
    E("button", {
      class: "button primary",
      text: "Retry local AI",
      onclick: () => {
        interpreter?.restart();
        updateAI({
          status: "idle",
          message: "Restarting local AI with cached model files.",
        });
        scheduleSemantic();
        $("#modal").close();
      },
    }),
    E("button", {
      class: "text-button",
      text: "Pause AI",
      onclick: () => {
        interpreter?.pause();
        updateAI({ status: "paused", message: "Local AI paused" });
        $("#modal").close();
      },
    }),
  );
