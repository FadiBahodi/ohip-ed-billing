// ED OHIP Billing Advisor — app controller (Subsystem 5, APP).
// Wires: engine/parse.js (Read the case -> facts) -> engine/pick.js (facts -> codes)
// -> engine/claim.js (codes -> copy line + CSV + Epic card). Deterministic. FREE.
// Local-only by default: no network, no LLM, no keys. The chips path is ALWAYS the local engine.
// OPTIONAL assistant bridge: if the user sets a bridge URL+token in Settings, "Read the case"
// POSTs the case to THEIR own local `claude -p` bridge (bridge/serve.py) and renders its answer.
// Bridge is opt-in, token-gated, and falls back to the local engine on any error/timeout.
//
// The verified engines are UMD: imported in the browser they assign a global
// (self.BillingEngine / BillingParse / BillingClaim) instead of ESM exports.
// We call pick(facts,{codes,rules}) so its Node-only fs loader never runs client-side.

// data + module locations. "../" resolves first (served from repo root -> /app/index.html).
const RULES_PATHS  = ["../data/rules.json", "./data/rules.json", "/data/rules.json"];
const CODES_PATHS  = ["../data/codes.json", "./data/codes.json", "/data/codes.json"];
const ENGINE_PATHS = ["../engine/pick.js",  "./engine/pick.js",  "/engine/pick.js"];
const PARSE_PATHS  = ["../engine/parse.js", "./engine/parse.js", "/engine/parse.js"];
const CLAIM_PATHS  = ["../engine/claim.js", "./engine/claim.js", "/engine/claim.js"];

// PRIVACY: no billing credentials or bridge secrets in source. They live only in this browser's
// localStorage, entered by the user in Settings. Empty until set. The bridge URL/token are used ONLY
// to reach the user's own local `claude -p` bridge; leave them blank to stay fully local.
const OHIP_KEY = "billing_ohip", GROUP_KEY = "billing_group";
const BRIDGE_URL_KEY = "billing_bridge_url", BRIDGE_TOKEN_KEY = "billing_bridge_token";
const BRIDGE_TIMEOUT_MS = 130000; // ~130s: claude -p can take a while; longer than the bridge's own 120s.

function lsGet(key)  { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }
function getOhip()   { return lsGet(OHIP_KEY); }
function getGroup()  { return lsGet(GROUP_KEY); }
function getBridgeUrl()   { return lsGet(BRIDGE_URL_KEY); }
function getBridgeToken() { return lsGet(BRIDGE_TOKEN_KEY); }
function setStored(key, val) {
  try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); } catch (e) { /* private mode */ }
}

// ---- bridge discovery + effective URL ----
// The bridge publishes its CURRENT tunnel URL to bridge.json at the site root (same-origin as this
// app). We fetch it so the user never has to paste a URL — only a token. A manual URL (Settings
// override) always wins over the discovered one. discoveredBridgeUrl is cached in memory and
// re-fetched right before each bridge call so a just-restarted bridge (new tunnel URL) is picked up.
const DISCOVERY_PATH = "bridge.json"; // relative, same-origin (served next to index.html)
const DISCOVERY_TIMEOUT_MS = 5000;
const PING_TIMEOUT_MS = 4000;
let discoveredBridgeUrl = "";
let bridgeStatusTimer = null;

async function fetchDiscovery() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const r = await fetch(DISCOVERY_PATH + "?t=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const u = (j && typeof j.url === "string") ? j.url.trim().replace(/\/+$/, "") : "";
      discoveredBridgeUrl = u; // may legitimately clear if the file goes empty
    }
    // non-200 (e.g. no bridge.json deployed): keep whatever we had — the local engine still works.
  } catch (e) {
    /* offline / no discovery file — leave discoveredBridgeUrl as-is */
  } finally {
    clearTimeout(timer);
  }
  return discoveredBridgeUrl;
}

// The URL "Read the case" actually uses: a manual Settings override if present, else the discovered one.
function effectiveBridgeUrl() {
  const manual = getBridgeUrl().trim().replace(/\/+$/, "");
  return manual || discoveredBridgeUrl;
}

// REAL connection status: pings the bridge's GET / and reports the TRUTH (not "boxes filled").
//   GREEN  — ping returns ok:true AND a token is set.
//   AMBER  — bridge is reachable but no token yet.
//   GREY   — no URL, or the ping fails/times out (bridge not reachable).
async function bridgeStatus() {
  const wrap = $("bridge-status"), txt = $("bridge-status-text");
  if (!wrap || !txt) return;
  const setState = (cls, message) => {
    wrap.classList.remove("on", "amber");
    if (cls) wrap.classList.add(cls);
    txt.textContent = message;
  };

  const url = effectiveBridgeUrl();
  const token = getBridgeToken();
  if (!url) { setState("", "Local engine — bridge not reachable (is your Mac on?)"); return; }

  setState("", "Checking your bridge…"); // neutral while we actually reach out

  let reachable = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(url + "/", { cache: "no-store", signal: ctrl.signal });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      reachable = !!(j && j.ok === true);
    }
  } catch (e) {
    reachable = false;
  } finally {
    clearTimeout(timer);
  }

  if (!reachable) { setState("", "Local engine — bridge not reachable (is your Mac on?)"); return; }
  if (!token)     { setState("amber", "Bridge found, add your token"); return; }
  setState("on", "Connected — Read the case uses your Claude");
}

// Debounced status refresh for keystrokes in the token/URL fields (~500ms).
function scheduleBridgeStatus() {
  clearTimeout(bridgeStatusTimer);
  bridgeStatusTimer = setTimeout(() => { bridgeStatus(); }, 500);
}

const state = {
  rules: null, codes: null, byCode: {},
  pickFn: null, parseFn: null, buildClaim: null,
  facts: { time_band: "day", complexity: "comprehensive", procedures: [], special_visit: false },
  procQuery: "",
  lastResult: null, lastClaim: null, loading: false,
};

const $ = (id) => document.getElementById(id);

// ---- boot ----
init().catch((err) => {
  console.error(err);
  setBadge("data error", "warn");
  $("hero-label").textContent = "Could not load the code base. Serve from the billing/ root: python3 -m http.server 8791";
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

  // DISCOVERY: learn the bridge URL published at the site root, THEN show the real status.
  // Non-blocking: everything above already rendered; status resolves once the ping returns.
  fetchDiscovery().then(bridgeStatus);
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

// ---- settings: OHIP# + group + optional assistant bridge, stored ONLY in localStorage ----
function wireSettings() {
  const ohipIn = $("set-ohip"), groupIn = $("set-group");
  const urlIn = $("set-bridge-url"), tokIn = $("set-bridge-token");
  const status = $("settings-status"), clearBtn = $("settings-clear");
  if (!ohipIn || !groupIn) return;

  ohipIn.value = getOhip();
  groupIn.value = getGroup();
  if (urlIn) urlIn.value = getBridgeUrl();
  if (tokIn) tokIn.value = getBridgeToken();

  const refresh = () => {
    const o = getOhip(), g = getGroup();
    status.textContent = (o || g)
      ? `Saved in this browser: OHIP# ${o || "—"} · Group ${g || "—"}`
      : "Until set, the claim header shows “OHIP# —”.";
  };

  // The prominent "Use your Claude" card's status is driven by the module-level bridgeStatus(),
  // which actually PINGS the bridge (see above). Keystrokes here debounce a real re-ping (~500ms).
  ohipIn.addEventListener("input", () => { setStored(OHIP_KEY, ohipIn.value.trim()); refresh(); compute(); });
  groupIn.addEventListener("input", () => { setStored(GROUP_KEY, groupIn.value.trim()); refresh(); compute(); });
  if (urlIn) urlIn.addEventListener("input", () => {
    // Trim any trailing slash(es); the bridge path (/bill) is appended at call time. Blank = auto-detect.
    setStored(BRIDGE_URL_KEY, urlIn.value.trim().replace(/\/+$/, "")); scheduleBridgeStatus();
  });
  if (tokIn) tokIn.addEventListener("input", () => { setStored(BRIDGE_TOKEN_KEY, tokIn.value.trim()); scheduleBridgeStatus(); });
  clearBtn.addEventListener("click", () => {
    setStored(OHIP_KEY, ""); setStored(GROUP_KEY, "");
    setStored(BRIDGE_URL_KEY, ""); setStored(BRIDGE_TOKEN_KEY, "");
    ohipIn.value = ""; groupIn.value = "";
    if (urlIn) urlIn.value = ""; if (tokIn) tokIn.value = "";
    refresh(); bridgeStatus(); compute();
    toast("Settings cleared");
  });

  refresh();
  // Initial status paint is driven from init() after discovery resolves.
}

// ---- (a) free text -> parse -> chips + pick() ----
function wireFreeText() {
  const run = () => readCase();
  $("parse-btn").addEventListener("click", run);
  $("case-text").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });
}

// Router: bridge (the user's own Claude) when we HAVE a URL (discovered or manual override) AND a
// token, else the local parser. Re-fetches discovery first so a just-restarted bridge (new tunnel
// URL) is picked up. Falls back to the local engine on any bridge error/timeout/non-200.
async function readCase() {
  if (state.loading) return; // guard against double-submit (button disabled + Cmd+Enter)
  const text = $("case-text").value.trim();
  const hint = $("parse-hint");
  hint.classList.remove("err");
  if (!text) { hint.textContent = "Type the case first, or set the chips."; hint.classList.add("err"); return; }

  await fetchDiscovery(); // pick up a fresh tunnel URL before routing
  const url = effectiveBridgeUrl(), token = getBridgeToken();
  if (url && token) {
    setLoading(true);
    setBadge("asking your Claude…", "info");
    hint.textContent = "Asking your Claude…";
    try {
      const answer = await callBridge(url, token, text);
      renderBridge(answer);
      hint.textContent = "Answered by your Claude. Touch a chip to override with the local engine.";
    } catch (e) {
      console.warn("bridge failed, falling back to local engine:", e);
      readCaseLocal(text, hint, true);
    } finally {
      setLoading(false);
      bridgeStatus(); // reflect real reachability after the call
    }
    return;
  }
  readCaseLocal(text, hint, false);
  bridgeStatus();
}

// Deterministic local path: parse(text) -> facts -> chips + pick(). Always available, always FREE.
function readCaseLocal(text, hint, offlineNote) {
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
  hint.textContent = (offlineNote ? "Assistant offline — used the local engine. " : "") +
    "Read: " + bits.join(" · ") + ". Adjust the chips if needed.";
}

function setLoading(on) {
  state.loading = !!on;
  const b = $("parse-btn");
  if (!b) return;
  b.disabled = !!on;
  b.textContent = on ? "Asking your Claude…" : "Read the case";
}

// POST {case} to <url>/bill with the token; return the parsed answer object (the bridge's inner JSON).
// The bridge returns {"answer":"<json string>"}; that string may be wrapped in ```json fences.
async function callBridge(url, token, caseText) {
  const base = String(url || "").replace(/\/+$/, ""); // defensive: never emit //bill
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const r = await fetch(base + "/bill", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Bridge-Token": token || "" },
      body: JSON.stringify({ case: caseText }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("bridge HTTP " + r.status);
    const data = await r.json();
    const raw = (data && typeof data.answer === "string") ? data.answer
              : (typeof data === "string" ? data : JSON.stringify(data));
    return parseBridgeAnswer(raw);
  } finally {
    clearTimeout(timer);
  }
}

// Strip ```json ... ``` fences and parse. If the model wrapped the JSON in prose, fall back to the
// first {...last} slice. Throws if nothing parses (caller then uses the local engine).
function parseBridgeAnswer(raw) {
  let t = String(raw || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  try { return JSON.parse(t); }
  catch (e) {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw e;
  }
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
  hideAsk(); // local engine never asks; clear any question left over from a bridge answer

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

// ---- render: the assistant bridge answer (the user's own Claude) into the same hero card ----
// Bridge shape: {assessment:{code,label,amount}, premiums:[{code,label,detail}],
//                procedures:[{code,label,amount}], claim_line, warnings[], total, reasoning[], ask}
// Defensive against missing/oddly-typed fields since this is model output.
function renderBridge(answer) {
  const a = (answer && typeof answer === "object") ? answer : {};
  const assessment = (a.assessment && typeof a.assessment === "object") ? a.assessment : null;
  const premiums = Array.isArray(a.premiums) ? a.premiums : [];
  const procedures = Array.isArray(a.procedures) ? a.procedures : [];
  const warnings = Array.isArray(a.warnings) ? a.warnings : [];
  const reasoning = Array.isArray(a.reasoning) ? a.reasoning : [];
  const total = (typeof a.total === "number") ? a.total : 0;
  const claimLine = (typeof a.claim_line === "string") ? a.claim_line : "";
  const ask = (typeof a.ask === "string" ? a.ask : "").trim();

  setBadge("via your Claude", "ok");

  // hero: assessment is the big code + amount; total is the answer's own total.
  $("hero-code").textContent = (assessment && assessment.code) ? assessment.code : "—";
  $("hero-label").textContent = (assessment && assessment.label) ? assessment.label : "No assessment code returned.";
  $("hero-total").innerHTML = totalHtml(total);

  // line items: assessment ($), premiums (the .detail string), procedures ($).
  const ul = $("line-items");
  ul.innerHTML = "";
  if (assessment && assessment.code) {
    ul.appendChild(bridgeRow(assessment.code, assessment.label, "assessment", money(assessment.amount), false));
  }
  premiums.forEach((p) => { p = p || {}; ul.appendChild(bridgeRow(p.code, p.label, "premium", p.detail || "", true)); });
  procedures.forEach((p) => { p = p || {}; ul.appendChild(bridgeRow(p.code, p.label, "procedure", money(p.amount), false)); });

  // warnings (amber callout inside the answer)
  const wEl = $("hero-warnings");
  wEl.innerHTML = "";
  if (warnings.length) {
    wEl.hidden = false;
    warnings.forEach((w) => { const li = document.createElement("li"); li.textContent = w; wEl.appendChild(li); });
  } else { wEl.hidden = true; }

  // no per-line "* unconfirmed" flagging on the bridge path
  $("hero-unconfirmed").hidden = true;
  $("hero-unconfirmed").textContent = "";

  // claim line (Copy + exports read state below)
  $("claim-line").textContent = claimLine || "—";

  // a clarifying question, shown prominently, only when the bridge asked one
  if (ask) showAsk(ask); else hideAsk();

  // note
  const n = (assessment && assessment.code ? 1 : 0) + premiums.length + procedures.length;
  $("hero-note").textContent = n ? `${n} code${n > 1 ? "s" : ""}` : "";

  // why (reasoning)
  const why = $("why");
  why.innerHTML = "";
  reasoning.forEach((line) => { const li = document.createElement("li"); li.textContent = line; why.appendChild(li); });
  $("why-wrap").style.display = reasoning.length ? "" : "none";

  // the bridge returns no source URLs; hide the Sources disclosure for this answer.
  $("sources").innerHTML = "";
  $("sources-wrap").style.display = "none";

  // keep Copy + exports working: normalize into the pick() shape buildClaim understands.
  const norm = {
    assessment: assessment, premiums: premiums, procedures: procedures,
    claim_line: claimLine, total: total, warnings: warnings, reasoning: reasoning,
    has_unconfirmed: false,
  };
  state.lastResult = norm;
  const today = new Date().toISOString().slice(0, 10);
  state.lastClaim = state.buildClaim
    ? state.buildClaim(norm, { ohip: getOhip(), group: getGroup(), date: today })
    : null;
}

function bridgeRow(code, label, tag, amountText, isDetail) {
  const li = document.createElement("li");
  const c = document.createElement("span"); c.className = "li-code"; c.textContent = code || "—";
  const lab = document.createElement("span"); lab.className = "li-lab"; lab.textContent = label || "";
  const t = document.createElement("span"); t.className = "li-tag"; t.textContent = tag; lab.appendChild(t);
  const amt = document.createElement("span");
  amt.className = "li-amt" + (isDetail ? " percent" : ""); // detail strings styled like percent premiums
  amt.textContent = amountText || "";
  li.appendChild(c); li.appendChild(lab); li.appendChild(amt);
  return li;
}

function showAsk(text) { const el = $("bridge-ask"); if (!el) return; el.textContent = text; el.hidden = false; }
function hideAsk() { const el = $("bridge-ask"); if (!el) return; el.hidden = true; el.textContent = ""; }

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
