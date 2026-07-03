// ED OHIP Billing Advisor — app controller (Subsystem 5, APP).
// Wires: engine/parse.js (Read the case -> facts) -> engine/pick.js (facts -> codes)
// -> engine/claim.js (codes -> copy line + CSV + Epic card). Deterministic. FREE.
// No network, no LLM, no keys. Serves as static files (python3 -m http.server).
//
// The verified engines are UMD: imported in the browser they assign a global
// (self.BillingEngine / BillingParse / BillingClaim) instead of ESM exports.
// We call pick(facts,{codes,rules}) so its Node-only fs loader never runs client-side.

// data + module locations. Root-relative ("./") so it resolves under github.io/<repo>/.
// index.html sits at the site ROOT; data/ and engine/ are its siblings. NO leading slash.
const RULES_PATHS  = ["./data/rules.json"];
const CODES_PATHS  = ["./data/codes.json"];
const ENGINE_PATHS = ["./engine/pick.js"];
const PARSE_PATHS  = ["./engine/parse.js"];
const CLAIM_PATHS  = ["./engine/claim.js"];

// PRIVACY: no billing credentials in source. They live only in this browser's localStorage,
// entered by the user in Settings. Empty until set -> the claim header shows "OHIP# —".
const OHIP_KEY = "billing_ohip", GROUP_KEY = "billing_group";
function getOhip()  { try { return localStorage.getItem(OHIP_KEY)  || ""; } catch (e) { return ""; } }
function getGroup() { try { return localStorage.getItem(GROUP_KEY) || ""; } catch (e) { return ""; } }
function setStored(key, val) {
  try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); } catch (e) { /* private mode */ }
}

const state = {
  rules: null, codes: null, byCode: {},
  pickFn: null, parseFn: null, buildClaim: null,
  facts: { time_band: "day", complexity: "comprehensive", procedures: [], special_visit: false },
  procQuery: "",
  lastResult: null, lastClaim: null,
};

const $ = (id) => document.getElementById(id);

// ---- boot ----
init().catch((err) => {
  console.error(err);
  setBadge("data error", "warn");
  $("hero-label").textContent = "Could not load the code base. Serve from the site root: python3 -m http.server 8795";
});

async function init() {
  state.rules = await fetchFirst(RULES_PATHS);
  state.codes = await fetchFirst(CODES_PATHS);
  state.byCode = index(state.codes);

  const eng = await loadUmd(ENGINE_PATHS, "BillingEngine");
  const par = await loadUmd(PARSE_PATHS, "BillingParse");
  const cla = await loadUmd(CLAIM_PATHS, "BillingClaim");
  state.pickFn    = eng && typeof eng.pick === "function" ? eng.pick : null;
  state.parseFn   = par && typeof par.parse === "function" ? par.parse : null;
  state.buildClaim = cla && typeof cla.buildClaim === "function" ? cla.buildClaim : null;

  wireSearch();
  wireFreeText();
  wireExport();
  wireSettings();
  refreshControls();
  compute();
}

// ---- loaders ----
async function fetchFirst(paths) {
  let lastErr;
  for (const p of paths) {
    try {
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) return await r.json();
      lastErr = new Error(`${p} -> ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no path resolved");
}

async function loadUmd(paths, globalName) {
  for (const p of paths) {
    try {
      const mod = await import(p);
      // Prefer real ESM exports if present; else the UMD global the module assigned.
      const viaEsm = mod && (mod.default && typeof mod.default === "object" ? mod.default : mod);
      const g = (typeof self !== "undefined" && self[globalName]) ? self[globalName] : null;
      if (g) return g;
      if (viaEsm && (viaEsm.pick || viaEsm.parse || viaEsm.buildClaim)) return viaEsm;
    } catch (e) { /* try next path */ }
  }
  return null;
}

function index(codes) {
  const m = {};
  for (const c of codes) m[c.code] = c;
  return m;
}

// ---- chips ----
const COMMON_PROCS = ["G211", "G521", "G523", "G395", "G269", "Z459", "Z176", "Z101", "Z804", "D015", "Z341", "G313"];
const COMPLEXITY_ORDER = ["minor", "comprehensive", "multiple_systems", "reassessment", "critical", "resus", "consultation"];

function refreshControls() {
  renderRadio("time-chips",
    state.rules.time_bands.map((t) => ({ id: t.id, label: t.label, title: t.hours_rule })),
    () => state.facts.time_band,
    (id) => { state.facts.time_band = id; sync(); });

  const levels = [...state.rules.complexity_levels].sort(
    (a, b) => COMPLEXITY_ORDER.indexOf(a.id) - COMPLEXITY_ORDER.indexOf(b.id));
  renderRadio("complexity-chips",
    levels.map((c) => ({ id: c.id, label: c.label, title: c.definition })),
    () => state.facts.complexity,
    (id) => { state.facts.complexity = id; sync(); });

  renderRadio("svp-chips",
    [{ id: "svp", label: "Special visit (SVP)", title: state.rules.svp_rule }],
    () => (state.facts.special_visit ? "svp" : null),
    () => { state.facts.special_visit = !state.facts.special_visit; sync(); });

  renderProcedures(state.procQuery);
}

function sync() { refreshControls(); compute(); }

function renderRadio(containerId, items, getActive, onPick) {
  const el = $(containerId);
  el.innerHTML = "";
  for (const it of items) {
    const on = getActive() === it.id;
    const chip = chipEl(it.label, on, it.title, it.id);
    chip.addEventListener("click", () => onPick(it.id));
    el.appendChild(chip);
  }
}

function renderProcedures(query) {
  const procs = state.codes.filter((c) => c.category === "procedure");
  let list;
  if (query) {
    list = procs.filter((p) => (p.code + " " + p.label).toLowerCase().includes(query)).slice(0, 30);
  } else {
    const common = COMMON_PROCS.map((c) => state.byCode[c]).filter(Boolean);
    const extra = state.facts.procedures.map((c) => state.byCode[c]).filter((p) => p && !COMMON_PROCS.includes(p.code));
    list = [...common, ...extra];
  }
  const el = $("procedure-chips");
  el.innerHTML = "";
  for (const p of list) {
    const on = state.facts.procedures.includes(p.code);
    const chip = chipEl(`${p.code} · ${p.label}`, on, p.label, p.code);
    chip.addEventListener("click", () => {
      const i = state.facts.procedures.indexOf(p.code);
      if (i >= 0) state.facts.procedures.splice(i, 1);
      else state.facts.procedures.push(p.code);
      sync();
    });
    el.appendChild(chip);
  }
  if (list.length === 0) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "No procedure matches.";
    el.appendChild(none);
  }
}

function chipEl(label, on, title, dataId) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip" + (on ? " on" : "");
  b.textContent = label;
  if (title) b.title = title;
  if (dataId != null) b.dataset.id = dataId;
  b.setAttribute("aria-pressed", String(!!on));
  return b;
}

function wireSearch() {
  $("proc-search").addEventListener("input", (e) => {
    state.procQuery = e.target.value.trim().toLowerCase();
    renderProcedures(state.procQuery);
  });
}

// ---- settings: OHIP# + group, stored ONLY in this browser's localStorage ----
function wireSettings() {
  const ohipIn = $("set-ohip"), groupIn = $("set-group");
  const status = $("settings-status"), clearBtn = $("settings-clear");
  if (!ohipIn || !groupIn) return;

  ohipIn.value = getOhip();
  groupIn.value = getGroup();

  const refresh = () => {
    const o = getOhip(), g = getGroup();
    status.textContent = (o || g)
      ? `Saved in this browser: OHIP# ${o || "—"} · Group ${g || "—"}`
      : "Until set, the claim header shows “OHIP# —”.";
  };

  ohipIn.addEventListener("input", () => { setStored(OHIP_KEY, ohipIn.value.trim()); refresh(); compute(); });
  groupIn.addEventListener("input", () => { setStored(GROUP_KEY, groupIn.value.trim()); refresh(); compute(); });
  clearBtn.addEventListener("click", () => {
    setStored(OHIP_KEY, ""); setStored(GROUP_KEY, "");
    ohipIn.value = ""; groupIn.value = "";
    refresh(); compute();
    toast("Billing numbers cleared");
  });

  refresh();
}

// ---- (a) free text -> parse -> chips + pick() ----
function wireFreeText() {
  const run = () => readCase();
  $("parse-btn").addEventListener("click", run);
  $("case-text").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
}

function readCase() {
  const text = $("case-text").value.trim();
  const hint = $("parse-hint");
  hint.classList.remove("err");
  if (!text) { hint.textContent = "Type the case first, or set the chips."; hint.classList.add("err"); return; }
  if (!state.parseFn) { hint.textContent = "Parser unavailable; set the chips manually."; hint.classList.add("err"); return; }

  const f = state.parseFn(text);
  state.facts = {
    time_band: f.time_band,
    complexity: f.complexity,
    procedures: Array.isArray(f.procedures) ? f.procedures.slice() : [],
    special_visit: !!f.special_visit,
  };
  if (f.referral_source) state.facts.referral_source = f.referral_source;

  refreshControls();
  compute();

  const bits = [labelFor("time_band", f.time_band), labelFor("complexity", f.complexity)];
  if (f.procedures && f.procedures.length) bits.push(f.procedures.join(" + "));
  if (f.special_visit) bits.push("special visit");
  hint.textContent = "Read: " + bits.join(" · ") + ". Adjust the chips if needed.";
}

function labelFor(kind, id) {
  const src = kind === "time_band" ? state.rules.time_bands : state.rules.complexity_levels;
  const hit = src.find((x) => x.id === id);
  return hit ? hit.label : id;
}

// ---- compute: real engine, else a faithful local fallback ----
function compute() {
  const facts = JSON.parse(JSON.stringify(state.facts));
  let result, engine = "engine";
  if (state.pickFn) {
    try { result = state.pickFn(facts, { codes: state.codes, rules: state.rules }); }
    catch (e) { console.warn("engine pick() failed, using local fallback:", e); }
  }
  if (!result) { result = pickLocal(facts); engine = "fallback"; }

  state.lastResult = result;
  const today = new Date().toISOString().slice(0, 10);
  state.lastClaim = state.buildClaim
    ? state.buildClaim(result, { ohip: getOhip(), group: getGroup(), date: today })
    : null;

  render(result, engine);
}

// Local fallback mirrors engine/pick.js's contract shape so claim.js still works.
// The real engine supersedes this whenever engine/pick.js loads.
function pickLocal(facts) {
  const r = state.rules, reasoning = [];
  let assessment = null;
  if (facts.complexity === "critical" || facts.complexity === "resus") {
    const row = r.assessment_map.find((m) => m.complexity === facts.complexity);
    assessment = row ? state.byCode[row.code] : null;
  } else if (facts.special_visit) {
    const a = r.svp_assessment_by_complexity[facts.complexity];
    assessment = a ? state.byCode[a] : null;
  } else {
    const row = r.assessment_map.find((m) => m.prefix === "H" && m.time_band === facts.time_band && m.complexity === facts.complexity);
    assessment = row ? state.byCode[row.code] : null;
  }
  const premiums = [];
  if (facts.special_visit && assessment && assessment.prefix === "A") {
    const band = (r.svp_map.not_on_call || {})[facts.time_band];
    if (band && band.first_person && state.byCode[band.first_person]) premiums.push(state.byCode[band.first_person]);
  }
  const procedures = (facts.procedures || []).map((c) => state.byCode[c]).filter(Boolean);
  const items = [assessment, ...premiums, ...procedures].filter(Boolean);
  let total = 0, unc = false;
  items.forEach((it) => { if (typeof it.amount === "number" && it.amount_confirmed !== false) total += it.amount; else unc = true; });
  const parts = items.map((it) => it.code + " " + (typeof it.amount === "number" ? "$" + it.amount.toFixed(2) : "$?") + (it.amount_confirmed === false ? "*" : ""));
  let claim_line = parts.join(" + ");
  if (parts.length) claim_line += " = $" + total.toFixed(2);
  reasoning.push("Local fallback (engine/pick.js did not load). Codes shown are from the KB; verify $ vs the live SOB.");
  const citations = [...new Set(items.map((c) => c.source_url).filter(Boolean))];
  return { assessment, premiums, procedures, claim_line, reasoning, citations, warnings: [], total: Number(total.toFixed(2)), has_unconfirmed: unc };
}

// ---- render: the answer as the hero ----
function money(a) { return (typeof a === "number") ? "$" + a.toFixed(2) : "$?"; }
function isUnconfirmed(it) { return !(typeof it.amount === "number" && it.amount_confirmed !== false); }
function totalHtml(n) {
  const s = Number(n || 0).toFixed(2).split(".");
  return `$${s[0]}<span class="cents">.${s[1]}</span>`;
}

function render(result, engine) {
  setBadge(engine === "engine" ? "grounded engine" : "local fallback", engine === "engine" ? "ok" : "info");

  const items = [];
  if (result.assessment) items.push({ it: result.assessment, tag: tagFor(result.assessment) });
  (result.premiums || []).forEach((p) => items.push({ it: p, tag: "premium" }));
  (result.procedures || []).forEach((p) => items.push({ it: p, tag: "procedure" }));

  const hero = result.assessment || (items[0] && items[0].it) || null;
  $("hero-code").textContent = hero ? hero.code : "—";
  $("hero-label").textContent = hero ? hero.label : "Pick a time band and complexity, or read a case.";
  $("hero-total").innerHTML = totalHtml(typeof result.total === "number" ? result.total : 0);

  // line items
  const ul = $("line-items");
  ul.innerHTML = "";
  for (const { it, tag } of items) {
    const li = document.createElement("li");
    const code = document.createElement("span"); code.className = "li-code"; code.textContent = it.code;
    const lab = document.createElement("span"); lab.className = "li-lab";
    lab.textContent = it.label;
    const t = document.createElement("span"); t.className = "li-tag"; t.textContent = tag;
    lab.appendChild(t);
    const amt = document.createElement("span"); amt.className = "li-amt" + (isUnconfirmed(it) ? " unconfirmed" : "");
    if (it.amount_type === "percent_premium" && typeof it.percent === "number") {
      // percent premium: show "+X% = $Y" (a percent of the base fee, not a flat dollar).
      amt.classList.add("percent");
      amt.textContent = "+" + it.percent + "% = " + money(it.amount);
    } else {
      amt.textContent = money(it.amount) + (isUnconfirmed(it) ? "*" : "");
    }
    li.appendChild(code); li.appendChild(lab); li.appendChild(amt);
    ul.appendChild(li);
  }

  // warnings (e.g. one reduction per site) — shown prominently inside the answer.
  const wEl = $("hero-warnings");
  const warns = result.warnings || [];
  wEl.innerHTML = "";
  if (warns.length) {
    wEl.hidden = false;
    warns.forEach((w) => { const li = document.createElement("li"); li.textContent = w; wEl.appendChild(li); });
  } else { wEl.hidden = true; }

  // unconfirmed flag
  const uEl = $("hero-unconfirmed");
  if (result.has_unconfirmed) {
    uEl.hidden = false;
    uEl.textContent = "* $ not confirmed against the current SOB — verify before submitting.";
  } else { uEl.hidden = true; uEl.textContent = ""; }

  // claim line
  $("claim-line").textContent = result.claim_line || (items.length ? items.map((x) => x.it.code).join(" + ") : "—");

  // note
  $("hero-note").textContent = items.length ? `${items.length} code${items.length > 1 ? "s" : ""}` : "";

  // why
  const why = $("why");
  why.innerHTML = "";
  (result.reasoning || []).forEach((line) => { const li = document.createElement("li"); li.textContent = line; why.appendChild(li); });
  $("why-wrap").style.display = (result.reasoning || []).length ? "" : "none";

  // sources
  const src = $("sources");
  src.innerHTML = "";
  const cites = (result.citations && result.citations.length) ? result.citations
    : [...new Set(items.map((x) => x.it.source_url).filter(Boolean))];
  cites.forEach((url) => {
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = url;
    src.appendChild(a);
  });
  $("sources-wrap").style.display = cites.length ? "" : "none";
}

function tagFor(a) {
  if (!a) return "assessment";
  if (a.prefix === "G") return "time-based";
  if (a.prefix === "A") return "assessment (A)";
  return "assessment";
}

// ---- copy + export ----
function wireExport() {
  $("copy-claim").addEventListener("click", (e) => {
    const line = state.lastResult ? state.lastResult.claim_line : "";
    copyOut(line, e.currentTarget, "Claim line copied");
  });

  $("export").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-export]");
    if (!btn) return;
    const c = state.lastClaim;
    if (!c) { toast("Nothing to export yet"); return; }
    const kind = btn.dataset.export;
    if (kind === "text") copyOut(c.text, null, "Full claim block copied");
    else if (kind === "epic") copyOut(c.epicCard, null, "Epic card copied");
    else if (kind === "csv") {
      const date = new Date().toISOString().slice(0, 10);
      download(`ohip_claim_${date}.csv`, "text/csv", c.csv);
      toast("CSV downloaded");
    }
  });
}

async function copyOut(text, btn, msg) {
  const ok = await copyText(text || "");
  toast(ok ? msg : "Copy blocked — select and copy manually");
  if (ok && btn) {
    const prev = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1200);
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

function download(filename, mime, content) {
  try {
    const blob = new Blob([content], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) { toast("Download blocked"); }
}

let toastTimer = null;
function toast(msg) {
  const el = $("copy-toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

function setBadge(text, kind) {
  const b = $("engine-badge");
  b.textContent = text;
  b.className = "badge " + (kind || "");
}
