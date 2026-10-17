// logsense web app: plain JS, no build step.
"use strict";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : n ?? "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const NON_INFO = {
  openstack: ["WARNING", "ERROR", "CRITICAL"],
  bgl: ["WARNING", "SEVERE", "ERROR", "FAILURE", "FATAL"],
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

// Read a server-sent-event stream from a POST request and call onEvent for each JSON event.
async function stream(path, body, onEvent, signal) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function markdown(text) {
  const html = window.marked ? marked.parse(text || "") : `<pre>${esc(text)}</pre>`;
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}

function sqlDetails(queries) {
  if (!queries || !queries.length) return "";
  const total = queries.reduce((s, q) => s + (q.ms || 0), 0);
  return `<details><summary>SQL (${queries.length} quer${queries.length === 1 ? "y" : "ies"}, ${total.toFixed(1)} ms)</summary>${
    queries.map((q) => `<div class="sql-ms">${q.ms} ms · ${fmt(q.rows)} row${q.rows === 1 ? "" : "s"}</div><pre class="sql">${esc(q.sql)}</pre>`).join("")}</details>`;
}

function table(el, rows, columns) {
  if (!rows || !rows.length) { el.innerHTML = `<tr><td class="muted">No rows.</td></tr>`; return; }
  const cols = columns || Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const numeric = (c) => typeof (c.render ? c.render(rows[0]) : rows[0][c.key]) === "number";
  el.innerHTML = `<thead><tr>${cols.map((c) => `<th class="${numeric(c) ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${cols.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      const cls = typeof v === "number" ? "num" : c.cls || "";
      return `<td class="${cls}">${c.html ? v : esc(typeof v === "number" ? fmt(v) : Array.isArray(v) ? v.join(", ") : v)}</td>`;
    }).join("")}</tr>`).join("")}</tbody>`;
}

// ---------------------------------------------------------------- status + tabs
let STATUS = null;

async function loadStatus() {
  try { STATUS = await api("/api/status"); } catch (e) { STATUS = { db: { ok: false, error: e.message } }; }
  const db = STATUS.db || {};
  const t = db.tables || {};
  const loaded = db.ok && t.openstack_logs && t.bgl_logs;
  const pills = [
    `<span class="pill"><span class="dot ${db.ok ? "ok" : "bad"}"></span>SereneDB ${db.ok ? "connected" : "offline"}</span>`,
    `<span class="pill"><span class="dot ${loaded ? "ok" : "warn"}"></span>${loaded
      ? `${fmt(t.openstack_logs)} OpenStack · ${fmt(t.bgl_logs)} BGL lines` : "data not loaded"}</span>`,
    `<span class="pill"><span class="dot ${STATUS.claude ? "ok" : "bad"}"></span>Claude Code ${STATUS.claude ? "found" : "not found"}</span>`,
  ];
  $("#status").innerHTML = pills.join("");
  renderChecklist();
  return STATUS;
}

function renderChecklist() {
  const s = STATUS || {};
  const db = s.db || {};
  const t = db.tables || {};
  const items = [
    [db.ok, "SereneDB reachable on localhost:7890", db.ok ? db.version : `Start it with <code>docker compose up -d</code>. (${esc(db.error || "")})`],
    [s.csv && s.csv["openstack.csv"] && s.csv["bgl.csv"], "CSVs prepared in data/", s.csv && s.csv["openstack.csv"] && s.csv["bgl.csv"]
      ? "data/openstack.csv, data/bgl.csv" : "Put the raw logs in data/ (see data/README.md), then run setup."],
    [!!(t.openstack_logs && t.bgl_logs), "Logs loaded",
      t.openstack_logs ? `${fmt(t.openstack_logs)} OpenStack + ${fmt(t.bgl_logs)} BGL rows` : "Run setup."],
    [!!t.team_ownership, "Team-ownership table", t.team_ownership ? `${t.team_ownership} component → team rows` : "Created by setup."],
    [!!db.search_index, "Full-text search indexes", db.search_index ? "openstack_search, bgl_search" : "Created by setup."],
    [!!s.claude, "Claude Code CLI", s.claude ? esc(s.claude) : "Install Claude Code and run <code>claude</code> once to sign in."],
    [!!s.mcp_config, ".mcp.json present", "Lets Claude Code start the serenedb-logs MCP server."],
  ];
  $("#checklist").innerHTML = items.map(([ok, label, hint]) =>
    `<li><span class="dot ${ok ? "ok" : "bad"}"></span><div><div>${label}</div><div class="hint">${hint}</div></div></li>`).join("");
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (name === "explore") loadExplore();
  if (name === "setup") loadStatus();
}

// ---------------------------------------------------------------- ask
let ROLES = [];
let currentRole = null;
let abort = null;

const ROLE_BLURB = {
  manager: "What to act on first and who owns it, in plain words.",
  team_lead: "Which problems recur, how often, and which teams own them.",
  engineer: "What failed, the raw evidence, the likely cause and the next check.",
};

async function loadRoles() {
  ROLES = await api("/api/roles");
  currentRole = currentRole || ROLES[0].id;
  $("#roles").innerHTML = ROLES.map((r) =>
    `<button type="button" class="role" role="radio" data-role="${r.id}" aria-checked="${r.id === currentRole}">
       <b>${esc(r.title.split(":")[0])}</b><span>${esc(ROLE_BLURB[r.id] || r.title)}</span>
       <em class="level">${esc(r.level || "")}</em></button>`).join("");
  $("#roles").querySelectorAll(".role").forEach((b) => b.addEventListener("click", () => selectRole(b.dataset.role)));
  selectRole(currentRole);
}

function selectRole(id) {
  currentRole = id;
  document.querySelectorAll(".role").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.role === id)));
  $("#question").value = (ROLES.find((r) => r.id === id) || {}).question || "";
}

function argText(args) {
  return Object.entries(args || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}

const HEADLINE_LABELS = {
  total_matching_lines: "matching lines", total_lines_in_window: "lines in window", total_lines_in_scope: "lines in scope",
  total_groups: "groups", total_lines: "lines", buckets_with_data: "buckets", returned: "returned",
};

function headlineChips(h) {
  const chips = [];
  for (const [k, label] of Object.entries(HEADLINE_LABELS)) if (k in h) chips.push(`<span class="chip">${fmt(h[k])} ${label}</span>`);
  if (h.lines_per_bucket) chips.push(`<span class="chip">per bucket ${h.lines_per_bucket.min}–${h.lines_per_bucket.max} (median ${h.lines_per_bucket.median})</span>`);
  if (h.summary) chips.push(`<span class="chip">${fmt(h.summary.lines)} lines · ${h.summary.labelled_anomaly ? "labelled anomaly" : "not labelled"}</span>`);
  if (h.groups) chips.push(...h.groups.map((g) => `<span class="chip">${esc(Object.values(g)[0])}: n=${fmt(g.n)}, avg ${g.avg_s}s, p95 ${g.p95_s}s</span>`));
  if (h.truncated) chips.push(`<span class="chip warn">truncated: sample shown</span>`);
  return chips.join("");
}

function onAskEvent(ev) {
  const tl = $("#timeline");
  if (ev.type === "note") {
    tl.insertAdjacentHTML("beforeend", `<li class="note" data-head="${esc(ev.text.trim().slice(0, 80))}">${esc(ev.text.length > 280 ? ev.text.slice(0, 280) + "…" : ev.text)}</li>`);
  } else if (ev.type === "tool_call") {
    tl.insertAdjacentHTML("beforeend", `<li class="call" id="call-${ev.id}"><div class="call-head">
      <span class="call-tool">${esc(ev.tool)}</span><span class="call-args">${esc(argText(ev.args))}</span>
      <span class="call-state"><span class="spinner"></span> running</span></div><div class="call-body"></div></li>`);
    $("#ask-state").textContent = `Claude is calling ${ev.tool}…`;
  } else if (ev.type === "tool_result") {
    const li = document.getElementById(`call-${ev.id}`);
    if (!li) return;
    li.querySelector(".call-state").outerHTML = ev.error ? `<span class="call-state" style="color:var(--bad)">error</span>` : `<span class="call-state done">done</span>`;
    const rows = ev.rows_preview && ev.rows_preview.length
      ? `<details><summary>First ${ev.rows_preview.length} rows</summary><div class="table-wrap"><table class="data"></table></div></details>` : "";
    li.querySelector(".call-body").innerHTML = (ev.error ? `<div class="chips"><span class="chip warn">${esc(ev.error)}</span></div>` : "")
      + `<div class="chips">${headlineChips(ev.headline || {})}</div>${rows}${sqlDetails(ev.queries)}`;
    if (rows) table(li.querySelector("table"), ev.rows_preview.map((r) => ({ ...r, message: r.message && r.message.length > 160 ? r.message.slice(0, 160) + "…" : r.message })));
    $("#ask-state").textContent = "Claude is reading the results…";
  } else if (ev.type === "final") {
    // Claude's last text block is the answer itself: show it once, in the Answer panel.
    const last = tl.lastElementChild;
    if (last && last.classList.contains("note") && ev.answer.trim().startsWith(last.dataset.head)) last.remove();
    $("#answer").classList.remove("empty");
    $("#answer").innerHTML = markdown(ev.answer);
    collapseQueries($("#answer"));
    const secs = ev.duration_ms ? `${(ev.duration_ms / 1000).toFixed(0)} s` : "";
    const cost = ev.cost_usd != null ? ` · $${ev.cost_usd.toFixed(2)}` : "";
    $("#answer-meta").textContent = `${ev.tool_calls} tool call${ev.tool_calls === 1 ? "" : "s"} · ${secs}${cost}`
      + (replayed ? ` · saved answer from ${replayed}` : "");
  } else if (ev.type === "start" && ev.replay) {
    replayed = ev.replay;
  } else if (ev.type === "saved") {
    $("#answer-meta").textContent += ` · saved to ${ev.path}`;
    loadSaved();
  } else if (ev.type === "error") {
    $("#answer").classList.remove("empty");
    $("#answer").innerHTML = `<p style="color:var(--bad)"><b>Claude could not answer.</b></p><pre>${esc(ev.message)}</pre>`;
  }
}

// The answer's closing "Queries" section is for checking: keep it one click away instead of in the way.
function collapseQueries(el) {
  const h = [...el.querySelectorAll("h1, h2, h3")].find((x) => /^queries\b/i.test(x.textContent.trim()));
  if (!h) return;
  const box = document.createElement("details");
  box.className = "queries";
  box.innerHTML = "<summary>Queries behind these numbers (SQL)</summary>";
  while (h.nextSibling) box.appendChild(h.nextSibling);
  h.replaceWith(box);
}

let replayed = null;

async function loadSaved() {
  try { SAVED = await api("/api/runs"); } catch { SAVED = []; }
  const groups = {};
  for (const r of SAVED) (groups[r.source] = groups[r.source] || []).push(r);
  $("#saved").innerHTML = `<option value="">Show a saved answer…</option>` + Object.entries(groups).map(([src, runs]) =>
    `<optgroup label="${esc(src)}">${runs.map((r) =>
      `<option value="${esc(r.id)}">${esc(r.title.split(":")[0])}: ${esc(r.question.slice(0, 60))}${r.question.length > 60 ? "…" : ""}</option>`).join("")}</optgroup>`).join("");
}
let SAVED = [];

async function showSaved() {
  const run = SAVED.find((r) => r.id === $("#saved").value);
  if (!run || abort) return;
  if (run.role) selectRole(run.role);
  $("#question").value = run.question;
  await runAsk("/api/replay", { id: run.id }, "Loading the saved answer…");
  $("#saved").value = "";
}

async function ask(e) {
  e.preventDefault();
  await runAsk("/api/ask", { role: currentRole, question: $("#question").value }, "Starting Claude Code…");
}

async function runAsk(path, body, startText) {
  if (abort) return;
  replayed = null;
  $("#timeline").innerHTML = "";
  $("#answer").className = "md empty";
  $("#answer").innerHTML = `<span class="spinner"></span> Claude is planning which tools to use…`;
  $("#answer-meta").textContent = "";
  $("#ask-btn").disabled = true;
  $("#stop-btn").hidden = false;
  $("#ask-state").textContent = startText;
  abort = new AbortController();
  try {
    await stream(path, body, onAskEvent, abort.signal);
    $("#ask-state").textContent = "";
  } catch (err) {
    $("#ask-state").textContent = err.name === "AbortError" ? "Stopped." : `Error: ${err.message}`;
    if ($("#answer").classList.contains("empty")) $("#answer").textContent = "No answer.";
  } finally {
    abort = null;
    $("#ask-btn").disabled = false;
    $("#stop-btn").hidden = true;
  }
}

// ---------------------------------------------------------------- explore
let dataset = "openstack";
const charts = {};
const DEFAULT_TREND = { openstack: '"unknown base file"', bgl: "" };

function chart(id, config) {
  if (charts[id]) charts[id].destroy();
  if (!window.Chart) { document.getElementById(id).replaceWith(Object.assign(document.createElement("p"), { className: "muted", textContent: "Chart library not loaded." })); return; }
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--chart-grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  charts[id] = new Chart(document.getElementById(id), config);
}

function span(first, last) {
  const [a, b] = [String(first), String(last)];
  return a.slice(0, 4) === b.slice(0, 4)
    ? [`${a.slice(5, 10)} → ${b.slice(5, 10)}`, `time span (${a.slice(0, 4)})`]
    : [`${a.slice(0, 7)} → ${b.slice(0, 7)}`, "time span"];
}

async function loadExplore() {
  const ds = dataset;
  $("#spawn-panel").hidden = ds !== "openstack";
  if (!$("#trend-q").dataset.touched) $("#trend-q").value = DEFAULT_TREND[ds];
  try {
    const [overview, teams, patterns] = await Promise.all([
      api("/api/tools/corpus_overview", {}),
      api("/api/tools/count_by", { dataset: ds, group_by: "team", levels: NON_INFO[ds] }),
      api("/api/tools/count_by", { dataset: ds, group_by: "message_pattern", levels: NON_INFO[ds], top: 10 }),
    ]);
    const o = overview.result[ds];
    const nonInfo = Object.entries(o.rows_by_level).filter(([lv]) => lv !== "INFO").reduce((s, [, n]) => s + n, 0);
    const kpis = [
      [fmt(o.rows), "log lines"],
      span(o.first_ts, o.last_ts),
      [fmt(nonInfo), `non-INFO lines (${(100 * nonInfo / o.rows).toFixed(2)}%)`],
      ds === "openstack" ? [o.labelled_anomaly_instances.length, "labelled anomaly VMs"] : [fmt(o.alert_rows), "labelled alert lines"],
    ];
    $("#kpis").innerHTML = kpis.map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");

    chart("chart-team", {
      type: "bar",
      data: { labels: teams.rows.map((r) => r.team), datasets: [{ label: "non-INFO lines", data: teams.rows.map((r) => r.lines), backgroundColor: cssVar("--chart-1"), borderRadius: 4 }] },
      options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmt(c.raw)} lines (${teams.rows[c.dataIndex].share_pct}%)` } } } },
    });
    $("#sql-team").innerHTML = sqlDetails(teams.queries);

    const entity = ds === "openstack" ? "distinct_instance_ids" : "distinct_nodes";
    table($("#patterns"), patterns.rows, [
      { key: "message_pattern", label: "pattern", cls: "msg" },
      { key: "teams", label: "team" },
      { key: "lines", label: "lines" },
      { key: "share_pct", label: "share %", render: (r) => r.share_pct },
      { key: entity, label: ds === "openstack" ? "VMs" : "nodes" },
      { key: "first_seen", label: "first seen", render: (r) => String(r.first_seen).slice(0, 16) },
      { key: "last_seen", label: "last seen", render: (r) => String(r.last_seen).slice(0, 16) },
    ]);
    $("#sql-patterns").innerHTML = (patterns.truncated ? `<div class="muted small">Showing ${patterns.returned} of ${patterns.total_groups} patterns.</div>` : "") + sqlDetails(patterns.queries);

    await loadTrend();
    if (ds === "openstack") await loadSpawn();
  } catch (err) {
    $("#kpis").innerHTML = `<div class="panel" style="grid-column:1/-1;color:var(--bad)">Could not query SereneDB: ${esc(err.message)}. Check the Setup tab.</div>`;
  }
}

async function loadTrend() {
  const q = $("#trend-q").value.trim();
  const args = { dataset, bucket: $("#trend-bucket").value, levels: NON_INFO[dataset] };
  if (q) args.query = q;
  const t = await api("/api/tools/trend", args);
  chart("chart-trend", {
    type: "bar",
    data: { labels: t.rows.map((r) => String(r.bucket_start).slice(0, args.bucket === "hour" ? 16 : 10)),
      datasets: [{ label: "lines", data: t.rows.map((r) => r.lines), backgroundColor: cssVar("--chart-2"), borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxRotation: 0, autoSkip: true } } } },
  });
  const per = t.lines_per_bucket ? ` · per ${args.bucket}: min ${t.lines_per_bucket.min}, median ${t.lines_per_bucket.median}, max ${t.lines_per_bucket.max}` : "";
  $("#sql-trend").innerHTML = `<div class="muted small">${fmt(t.total_lines)} non-INFO lines${q ? ` matching ${esc(q)}` : ""} in ${t.buckets_with_data} non-empty buckets${per}. Empty buckets are not shown.</div>${sqlDetails(t.queries)}`;
}

async function loadSpawn() {
  const d = await api("/api/tools/duration_stats", { metric: "spawn_seconds", group_by: "labelled_anomaly", slowest: 5 });
  table($("#spawn"), d.groups, [
    { key: "labelled_anomaly", label: "group", render: (r) => (r.labelled_anomaly ? "labelled anomaly VMs" : "all other VMs") },
    { key: "n", label: "spawns" }, { key: "avg_s", label: "avg s" }, { key: "p50_s", label: "median s" },
    { key: "p95_s", label: "p95 s" }, { key: "max_s", label: "max s" },
  ]);
  const slow = d.slowest.map((r) => `${r.instance_id.slice(0, 8)}… ${r.seconds}s${r.is_labelled_anomaly ? " (labelled)" : ""}`).join(" · ");
  $("#sql-spawn").innerHTML = `<div class="muted small">Slowest spawns: ${esc(slow)}</div>${sqlDetails(d.queries)}`;
}

async function search(e) {
  e.preventDefault();
  const q = $("#search-q").value.trim();
  if (!q) return;
  try {
    const r = await api("/api/tools/search_logs", { query: q, dataset, limit: 50 });
    $("#search-meta").textContent = `${fmt(r.total_matching_lines)} matching lines in ${dataset}${r.truncated ? `, showing the first ${r.returned}` : ""}.`;
    const cols = dataset === "openstack"
      ? [{ key: "ts", label: "time", render: (x) => String(x.ts).slice(0, 23) }, { key: "level", label: "level" }, { key: "component", label: "component" },
         { key: "split", label: "source", render: (x) => `${x.split}:${x.line_no}` }, { key: "message", label: "message", cls: "msg" }]
      : [{ key: "ts", label: "time", render: (x) => String(x.ts).slice(0, 23) }, { key: "level", label: "level" }, { key: "component", label: "component" },
         { key: "node", label: "node" }, { key: "message", label: "message", cls: "msg" }];
    table($("#search-results"), r.rows, cols);
    $("#sql-search").innerHTML = sqlDetails(r.queries);
  } catch (err) {
    $("#search-meta").textContent = `Error: ${err.message}`;
  }
}

// ---------------------------------------------------------------- setup
async function runSetup() {
  const log = $("#setup-log");
  log.textContent = "";
  $("#run-setup").disabled = true;
  $("#setup-state").innerHTML = `<span class="spinner"></span> running`;
  try {
    await stream("/api/setup", { download: $("#opt-download").checked, reconvert: $("#opt-reconvert").checked }, (ev) => {
      if (ev.type === "line") { log.textContent += ev.text + "\n"; log.scrollTop = log.scrollHeight; }
      if (ev.type === "done") $("#setup-state").textContent = ev.ok ? "Finished." : "Failed: see the output.";
    });
  } catch (err) {
    $("#setup-state").textContent = `Error: ${err.message}`;
  } finally {
    $("#run-setup").disabled = false;
    loadStatus();
  }
}

// ---------------------------------------------------------------- wire up
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
  dataset = b.dataset.ds;
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  delete $("#trend-q").dataset.touched;
  loadExplore();
  if ($("#search-q").value.trim()) search(new Event("submit"));
  else { $("#search-results").innerHTML = ""; $("#search-meta").textContent = ""; $("#sql-search").innerHTML = ""; }
}));
$("#ask-form").addEventListener("submit", ask);
$("#saved").addEventListener("change", showSaved);
$("#question").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask(e); });
$("#stop-btn").addEventListener("click", () => abort && abort.abort());
$("#trend-form").addEventListener("submit", (e) => { e.preventDefault(); $("#trend-q").dataset.touched = "1"; loadTrend().catch((err) => { $("#sql-trend").textContent = err.message; }); });
$("#search-form").addEventListener("submit", search);
$("#run-setup").addEventListener("click", runSetup);
$("#recheck").addEventListener("click", loadStatus);

loadStatus().then((s) => { if (!(s.db && s.db.ok && s.db.tables && s.db.tables.openstack_logs)) showTab("setup"); });
loadRoles();
loadSaved();
