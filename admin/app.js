// Study admin dashboard: progress, data quality, per-session review (audio +
// transcript + synced screen replay), settings, and exports. Reads go through
// RLS (admins only); writes go through admin_* RPCs.

import { CONFIG } from "../js/config.js";
import { el } from "../js/util.js";

const sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: true, storageKey: "study-admin-auth" },
});
const app = document.getElementById("app");
const state = { includeTests: localStorage.getItem("admin-include-tests") === "1", timer: null };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function q(builder) {
  const { data, error } = await builder;
  if (error) throw new Error(error.message);
  return data;
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const median = (xs) => { const a = xs.filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const mean = (xs) => { const a = xs.filter((x) => x !== null && !Number.isNaN(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const fmtSec = (ms) => (ms === null ? "–" : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${Math.round(ms / 1000)}s`);
const fmtPct = (x) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const fmt1 = (x) => (x === null ? "–" : (Math.round(x * 10) / 10).toString());
const ago = (iso) => { const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "–");
const TERMINAL = new Set(["completed", "screened_out", "declined", "invalidated"]);
const ARMS = { diagram: "Exp 1: diagram", tree: "Exp 2: answer tree", gemini: "Exp 3: open-ended" };
const STATUSES = ["started", "consented", "mic_ok", "warmup_done", "in_trials", "post_survey", "completed", "screened_out", "declined", "invalidated"];

function card(k, v, s = "") {
  return el("div", { class: "card" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), s ? el("div", { class: "s" }, s) : null);
}
function table(headers, rows, onClick = null, className = "") {
  return el("div", { class: `table-shell ${className}`.trim() },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, ...rows.map((r) => {
        const tr = el("tr", onClick ? { class: "click", onclick: () => onClick(r) } : {}, ...r.cells.map((c) => el("td", {}, c)));
        return tr;
      }))));
}
function pill(text, kind = "") { return el("span", { class: `pill ${kind}` }, text); }
function download(name, text, type = "text/plain") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => { if (v === null || v === undefined) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
async function blobText(blob, gz) {
  if (!gz) return blob.text();
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

// ---------------------------------------------------------------------------
// auth + layout
// ---------------------------------------------------------------------------

async function isAdmin() {
  const { data } = await sb.rpc("is_admin");
  return data === true;
}

function login(message = "") {
  const email = el("input", { type: "email", placeholder: "Email", autocomplete: "username" });
  const password = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = el("p", { class: "muted" }, message);
  const go = el("button", { class: "btn primary", type: "submit" }, "Sign in");
  const form = el("form", { class: "login" }, el("h1", {}, "Study admin"), email, password, go, msg);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    if (error) { msg.textContent = error.message; return; }
    if (!(await isAdmin())) { await sb.auth.signOut(); msg.textContent = "This account is not an admin."; return; }
    route();
  });
  app.replaceChildren(form);
}

// Each navigation gets a number; a slow view that finishes after a newer one
// started must not paint over it.
let navSeq = 0;
let viewSeq = 0;

function layout(active, ...body) {
  if (viewSeq !== navSeq) return;
  const tests = el("input", { type: "checkbox", checked: state.includeTests });
  tests.addEventListener("change", () => { state.includeTests = tests.checked; localStorage.setItem("admin-include-tests", tests.checked ? "1" : "0"); route(); });
  const link = (hash, label) => el("a", { href: hash, class: active === hash ? "active" : "" }, label);
  app.replaceChildren(
    el("nav", { class: "admin-nav" }, el("b", {}, "Think-aloud study"), link("#/overview", "Overview"), link("#/sessions", "Sessions"),
      link("#/settings", "Settings"), link("#/export", "Export"), el("span", { class: "spacer" }),
      el("label", {}, tests, " include TEST_ sessions"),
      el("a", { href: "#", onclick: async (e) => { e.preventDefault(); await sb.auth.signOut(); login(); } }, "Sign out")),
    el("main", { class: "admin-main" }, ...body));
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

const TRIAL_FIELDS = "session_id,trial_index,condition,item_index,correct,confidence,choice_side,submitted_at,tlx,"
  + "total_ms:data->total_ms,active_ms:data->active_ms,hidden_ms:data->hidden_ms,speech_ratio:data->speech_ratio,"
  + "nudges:data->nudges,marks:data->annotations->summary,variants:data->variants";

async function loadCore() {
  const [sessions, trials, recordings, slots, config, items, images, surveys, events] = await Promise.all([
    q(sb.from("sessions").select("id,prolific_pid,is_test,status,step,slot_index,created_at,updated_at,last_seen_at,completed_at,live,review_status,client").order("created_at", { ascending: false }).limit(2000)),
    q(sb.from("trials").select(TRIAL_FIELDS)),
    q(sb.from("recordings").select("id,session_id,segment,part,bytes,duration_ms,finalized,transcript_status,created_at")),
    q(sb.from("slots").select("*").order("assignment_rank")),
    q(sb.from("config").select("*").single()),
    q(sb.from("items").select("item_index,record_id,dataset,gold,meta").order("item_index")),
    q(sb.from("images").select("arm,item_index,side,path").limit(2000)),
    q(sb.from("surveys").select("*")),
    q(sb.from("session_events").select("session_id,type").in("type", ["resume", "nudge", "mic_check", "upload_drain", "vad_fallback", "js_error", "js_rejection"]).limit(20000)),
  ]);
  const keep = (s) => state.includeTests || !s.is_test;
  const shown = sessions.filter(keep);
  const ids = new Set(shown.map((s) => s.id));
  const armOfSlot = new Map(slots.map((s) => [s.slot_index, s.arm]));
  for (const s of sessions) s.arm = armOfSlot.get(s.slot_index) ?? null;
  const armOfSession = new Map(sessions.map((s) => [s.id, s.arm]));
  for (const t of trials) t.arm = armOfSession.get(t.session_id) ?? null;
  return {
    sessions: shown, allSessions: sessions, config, items, images, slots, surveys: surveys.filter((s) => ids.has(s.session_id)),
    trials: trials.filter((t) => ids.has(t.session_id)), recordings: recordings.filter((r) => ids.has(r.session_id)),
    events: events.filter((e) => ids.has(e.session_id)),
  };
}

function flagsFor(session, trials, survey, events) {
  const flags = [];
  for (const t of trials) {
    const ratio = num(t.speech_ratio);
    if (ratio !== null && ratio < 0.2) flags.push([`T${t.trial_index} little speech (${fmtPct(ratio)})`, "bad"]);
    if (num(t.nudges) >= 3) flags.push([`T${t.trial_index} ${t.nudges} nudges`, "warn"]);
    const total = num(t.total_ms);
    if (total !== null && total < (t.condition === "text" ? 60000 : 20000)) flags.push([`T${t.trial_index} fast (${fmtSec(total)})`, "warn"]);
    if (total && num(t.hidden_ms) / total > 0.2) flags.push([`T${t.trial_index} tab hidden ${fmtPct(num(t.hidden_ms) / total)}`, "warn"]);
  }
  const ev = events.filter((e) => e.session_id === session.id);
  if (ev.some((e) => e.type === "vad_fallback")) flags.push(["no Silero VAD", "warn"]);
  if (ev.filter((e) => e.type === "resume").length >= 2) flags.push(["resumed 2+ times", "warn"]);
  if (ev.filter((e) => e.type === "mic_check").length >= 3) flags.push(["mic check retries", "warn"]);
  if (ev.some((e) => e.type === "js_error" || e.type === "js_rejection")) flags.push(["JS errors", "warn"]);
  if (survey?.answers?.tech_problem === "yes") flags.push(["reported tech problem", "warn"]);
  const live = session.live || {};
  if (!TERMINAL.has(session.status) && live.outbox?.jobs > 20) flags.push([`upload backlog ${live.outbox.jobs}`, "bad"]);
  if (live.outbox?.dead > 0) flags.push([`${live.outbox.dead} permanently failed uploads`, "bad"]);
  return flags;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

async function viewOverview() {
  const seq = navSeq;
  const [d, health] = await Promise.all([loadCore(), sb.rpc("admin_health").then((r) => r.data || {})]);
  const warnings = [];
  if (!d.config.study_open) warnings.push('The study is CLOSED: real participants see "not open". Open it in Settings when you launch.');
  if (!d.config.completion_code) warnings.push("No Prolific completion code is set (Settings).");
  const needed = d.items.length * 2;
  for (const arm of d.config.open_arms) {
    const have = new Set(d.images.filter((i) => i.arm === arm).map((i) => `${i.item_index}${i.side}`)).size;
    if (have < needed) warnings.push(`${ARMS[arm]} is open but has images for only ${have} of ${needed} answers. Publish its images or close it in Settings.`);
  }
  if (!d.config.open_arms.length) warnings.push("No experiment is open (Settings), so real participants get \"study full\".");

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, d.sessions.filter((x) => x.status === s).length]));
  const real = d.slots.filter((s) => s.status !== "invalidated");
  const done = real.filter((s) => s.status === "completed").length;
  const reserved = real.filter((s) => s.status === "reserved").length;
  const live = d.sessions.filter((s) => !TERMINAL.has(s.status) && Date.now() - new Date(s.last_seen_at).getTime() < 60000);
  const tq = Object.fromEntries(["pending", "processing", "done", "error", "skipped"].map((k) => [k, d.recordings.filter((r) => r.transcript_status === k).length]));
  const audioMin = d.recordings.reduce((s, r) => s + (r.duration_ms || 0), 0) / 60000;

  const metrics = (cond) => {
    const ts = d.trials.filter((t) => t.condition === cond && t.submitted_at);
    return [
      cond === "text" ? "Text" : "Images", ts.length,
      fmtPct(mean(ts.map((t) => (t.correct === null ? null : t.correct ? 1 : 0)))),
      fmtSec(median(ts.map((t) => num(t.total_ms)))), fmtSec(median(ts.map((t) => num(t.active_ms)))),
      fmt1(mean(ts.map((t) => num(t.confidence)))), fmt1(mean(ts.map((t) => num(t.tlx?.raw_tlx)))),
      fmtPct(median(ts.map((t) => num(t.speech_ratio)))), fmt1(mean(ts.map((t) => num(t.nudges)))),
      fmt1(mean(ts.map((t) => num(t.marks?.live)))), fmt1(mean(ts.map((t) => num(t.marks?.notes)))),
    ];
  };

  const armRows = Object.entries(ARMS).map(([arm, name]) => {
    const sl = real.filter((s) => s.arm === arm);
    const ts = d.trials.filter((t) => t.arm === arm && t.condition === "image" && t.submitted_at);
    const tx = d.trials.filter((t) => t.arm === arm && t.condition === "text" && t.submitted_at);
    const acc = (xs) => fmtPct(mean(xs.map((t) => (t.correct === null ? null : t.correct ? 1 : 0))));
    return { cells: [name, d.config.open_arms.includes(arm) ? pill("open", "good") : pill("closed"),
      `${sl.filter((s) => s.status === "completed").length} / ${sl.length}`, sl.filter((s) => s.status === "reserved").length,
      `${tx.length} (${acc(tx)})`, `${ts.length} (${acc(ts)})`, fmtSec(median(ts.map((t) => num(t.total_ms)))),
      fmt1(mean(ts.map((t) => num(t.confidence))))] };
  });

  const itemRows = d.items.map((it) => {
    const ts = d.trials.filter((t) => t.item_index === it.item_index && t.submitted_at);
    const cell = (cond) => { const x = ts.filter((t) => t.condition === cond); return `${x.length} (${fmtPct(mean(x.map((t) => (t.correct ? 1 : 0))))})`; };
    return { cells: [it.item_index, it.dataset, it.record_id, `${it.meta?.words_a ?? "?"} / ${it.meta?.words_b ?? "?"}`, it.gold.toUpperCase(), cell("text"), cell("image")] };
  });

  viewSeq = seq;
  layout("#/overview",
    ...warnings.map((w) => el("div", { class: "warn" }, w)),
    el("h2", {}, "Progress"),
    el("div", { class: "cards" },
      card("Completed slots", `${done} / ${real.length}`, `${reserved} reserved now`),
      card("Live now", live.length, "seen in the last 60 s"),
      card("Sessions", d.sessions.length, `${byStatus.completed} completed`),
      card("Screened out / declined", byStatus.screened_out + byStatus.declined),
      card("Audio recorded", `${Math.round(audioMin)} min`),
      card("Transcripts", `${tq.done} done`, `${tq.pending + tq.processing} queued, ${tq.error} errors`)),
    el("div", { class: "panel" }, el("div", { class: "bar" },
      el("span", { style: `width:${(done / Math.max(1, real.length)) * 100}%;background:#16a34a` }),
      el("span", { style: `width:${(reserved / Math.max(1, real.length)) * 100}%;background:#93c5fd` }))),
    el("h2", {}, "Funnel"),
    table(STATUSES, [{ cells: STATUSES.map((s) => byStatus[s]) }]),
    el("h2", {}, "Live sessions"),
    live.length ? table(["Prolific ID", "Step", "Since start", "Speaking", "Level", "VAD", "Uploads queued", "Nudges"],
      live.map((s) => ({ s, cells: [s.prolific_pid, s.live?.step ?? s.step, fmtSec(s.live?.t ?? null), s.live?.speaking ? pill("speaking", "good") : pill("silent"),
                                    s.live?.level_db ?? "–", s.live?.vad ?? "–", s.live?.outbox?.jobs ?? "–", s.live?.nudges ?? 0] })),
      (r) => { location.hash = `#/session/${r.s.id}`; }) : el("p", { class: "muted" }, "Nobody is in the study right now."),
    el("h2", {}, "Text vs. images (submitted trials)"),
    table(["Condition", "Trials", "Accuracy vs gold", "Median time", "Median active", "Confidence (1–5)", "Raw TLX", "Median speech", "Nudges / trial", "Marks / trial", "Notes / trial"],
      [{ cells: metrics("text") }, { cells: metrics("image") }]),
    el("h2", {}, "By experiment"),
    table(["Experiment", "Open", "Completed slots", "Reserved", "Text trials (acc.)", "Image trials (acc.)", "Median image time", "Image confidence"], armRows),
    el("h2", {}, "Items"),
    table(["#", "Dataset", "Record", "Words A / B", "Gold", "Text trials (acc.)", "Image trials (acc.)"], itemRows),
    el("h2", {}, "Data safety"),
    el("div", { class: "panel" }, el("div", { class: "kv" },
      el("div", {}, "Keep-alive ping"), el("div", {}, health.last_ping ? `last ${ago(health.last_ping)} · 7 days: ${JSON.stringify(health.ping_sources_7d || {})}` : "never"),
      el("div", {}, "Backup to Cloudflare D1"), el("div", {}, health.last_backup
        ? `last run ${ago(health.last_backup.started_at)}: ${health.last_backup.note} · ${health.last_backup.rows_written ?? 0} rows, ${health.last_backup.objects ?? 0} files`
        : "no runs yet"),
      el("div", {}, "Scheduled jobs"), el("div", {}, (health.cron || []).map((c) => `${c.job} (${c.schedule})${c.active ? "" : " PAUSED"}`).join(" · ")))),
    el("h2", {}, "Transcription"),
    el("div", { class: "panel" }, `pending ${tq.pending} · processing ${tq.processing} · done ${tq.done} · skipped ${tq.skipped} · errors ${tq.error}  `,
      el("button", { class: "btn small", onclick: async (e) => { e.target.disabled = true; await sb.rpc("admin_transcribe_now"); e.target.textContent = "Triggered"; } }, "Transcribe now")));
}

async function viewSessions() {
  const seq = navSeq;
  const d = await loadCore();
  const rows = d.sessions.map((s) => {
    const ts = d.trials.filter((t) => t.session_id === s.id).sort((a, b) => a.trial_index - b.trial_index);
    const survey = d.surveys.find((x) => x.session_id === s.id);
    const flags = flagsFor(s, ts, survey, d.events);
    const duration = s.completed_at ? new Date(s.completed_at) - new Date(s.created_at) : null;
    return {
      s,
      cells: [
        el("span", { class: "session-id" }, el("span", {}, s.prolific_pid || "–"), s.is_test ? pill("test", "info") : null),
        pill(s.status, s.status === "completed" ? "good" : TERMINAL.has(s.status) ? "bad" : "info"),
        s.step, when(s.created_at), duration ? fmtSec(duration) : `seen ${ago(s.last_seen_at)}`, s.slot_index ?? "–", s.arm ? ARMS[s.arm] : "–",
        el("span", {}, ...ts.map((t) => pill(`${t.trial_index}: ${t.condition}${t.correct === null ? "" : t.correct ? ", correct" : ", wrong"}`, t.correct ? "good" : "bad"))),
        el("span", {}, ...ts.map((t) => `${fmtPct(num(t.speech_ratio))} `)),
        el("span", {}, ...flags.map(([text, kind]) => pill(text, kind))),
        pill(s.review_status, s.review_status === "approved" ? "good" : s.review_status === "rejected" ? "bad" : ""),
      ],
    };
  });
  viewSeq = seq;
  layout("#/sessions", el("h2", {}, `Sessions (${rows.length})`),
    table(["Prolific ID", "Status", "Step", "Started", "Duration", "Slot", "Experiment", "Trials", "Speech", "Flags", "Review"], rows,
      (r) => { location.hash = `#/session/${r.s.id}`; }, "sessions-table"));
}

async function loadRecordingAudio(rec, sessionId) {
  const prefix = `${sessionId}/${rec.id}`;
  const files = await q(sb.storage.from("recordings").list(prefix, { limit: 2000, sortBy: { column: "name", order: "asc" } }));
  if (!files.length) throw new Error("No audio chunks were uploaded for this recording.");
  const parts = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      parts[index] = await q(sb.storage.from("recordings").download(`${prefix}/${files[index].name}`));
    }
  }));
  return new Blob(parts, { type: (rec.mime || "audio/webm").split(";")[0] });
}

async function viewSession(id) {
  const seq = navSeq;
  const [session, events, trials, warmups, surveys, recordings, batches, slots] = await Promise.all([
    q(sb.from("sessions").select("*").eq("id", id).single()),
    q(sb.from("session_events").select("*").eq("session_id", id).order("id").limit(5000)),
    q(sb.from("trials").select("*").eq("session_id", id).order("trial_index")),
    q(sb.from("warmups").select("*").eq("session_id", id)),
    q(sb.from("surveys").select("*").eq("session_id", id)),
    q(sb.from("recordings").select("*, transcripts(*)").eq("session_id", id).order("created_at")),
    q(sb.from("telemetry_batches").select("*").eq("session_id", id).order("seq")),
    q(sb.from("slots").select("slot_index,arm")),
  ]);
  const created = new Date(session.created_at).getTime();
  const notes = el("textarea", { rows: 2 }, session.admin_notes || "");
  const review = el("select", {}, ...["unreviewed", "approved", "rejected", "flagged"].map((v) => el("option", { value: v, selected: v === session.review_status }, v)));

  const trialPanels = trials.map((t) => {
    const marks = (t.data?.annotations?.marks || []).filter((m) => !m.deleted_t);
    const metric = (label, value) => el("div", { class: "metric" }, el("span", {}, label), el("b", {}, value));
    return el("article", { class: "panel trial-card" },
      el("div", { class: "trial-heading" },
        el("div", {}, el("div", { class: "eyebrow" }, `Study question ${t.trial_index}`), el("h3", {}, `${t.condition === "image" ? "Image" : "Text"} answers · item ${t.item_index}`)),
        el("div", {}, pill(`chose ${t.choice_side?.toUpperCase() || "–"}`, "info"), t.correct === null ? null : t.correct ? pill("correct", "good") : pill("wrong", "bad"))),
      el("div", { class: "metric-grid" },
        metric("Confidence", t.confidence ?? "–"), metric("Total time", fmtSec(t.data?.total_ms ?? null)),
        metric("Active time", fmtSec(t.data?.active_ms ?? null)), metric("Speech", fmtPct(t.data?.speech_ratio ?? null)),
        metric("Nudges", t.data?.nudges ?? 0), metric("Raw TLX", t.tlx?.raw_tlx ?? "–")),
      el("details", { class: "inline-details" }, el("summary", {}, `Annotations (${marks.length})`),
        marks.length ? el("ul", { class: "marks" }, ...marks.map((m) => el("li", {},
          pill(m.valence || m.tool, m.valence === "good" ? "good" : m.valence === "bad" ? "bad" : m.valence === "unsure" ? "warn" : "info"),
          ` ${m.pane} (${m.side?.toUpperCase()}) ${m.kind} @${fmtSec(m.created_t - (t.data?.started_t ?? 0))}: `,
          m.kind === "text_highlight" ? `"${m.text}"` : m.kind === "note" ? `note: "${m.text}"` : `${m.points?.length} pts, bbox ${JSON.stringify(m.bbox)}`)))
          : el("p", { class: "muted" }, "No annotations.")),
      el("details", { class: "inline-details" }, el("summary", {}, "Technical details"), el("div", { class: "kv compact" },
        el("div", {}, "Tab hidden / blurred"), el("div", {}, `${fmtSec(t.data?.hidden_ms ?? null)} (${t.data?.hidden_count ?? 0}×) / ${fmtSec(t.data?.blur_ms ?? null)}`),
        el("div", {}, "Choice changes"), el("div", {}, t.data?.choice_changes ?? 0),
        el("div", {}, "Image variants"), el("div", {}, t.data?.variants ? JSON.stringify(t.data.variants) : "–"),
        el("div", {}, "Panes"), el("div", {}, JSON.stringify(t.data?.annotations?.panes ?? {})),
        el("div", {}, "TLX"), el("div", {}, t.tlx ? Object.entries(t.tlx).map(([k, v]) => `${k}: ${v}`).join(" · ") : "–"))));
  });

  const segmentNames = {
    study: "Full study audio",
    mic_check: "Microphone check",
    tutorial: "Tools practice",
    trial_1: "Study question 1",
    trial_2: "Study question 2",
    warmup_multiply: "Warm-up: multiplication",
    warmup_windows: "Warm-up: windows",
    warmup_animals: "Warm-up: animals",
  };
  const recLabel = (rec) => `${segmentNames[rec.segment] || rec.segment.replaceAll("_", " ")}${rec.part ? ` · part ${rec.part + 1}` : ""}`;
  const audioEls = new Map();
  const recPanel = (rec) => {
    const audio = el("audio", { controls: true, preload: "none" });
    const tr = rec.transcripts?.[0] || (Array.isArray(rec.transcripts) ? null : rec.transcripts);
    const words = tr?.words || [];
    const tx = el("div", { class: "transcript" }, ...(words.length ? words.map((w) => {
      const span = el("span", { class: "w", title: `${w.start}s` }, w.word);
      span.addEventListener("click", async () => { await ensureAudio(rec, audio); audio.currentTime = w.start; audio.play(); });
      span._w = w;
      return span;
    }) : [el("span", { class: "muted" }, tr?.text || `(transcript ${rec.transcript_status}${rec.transcript_error ? `: ${rec.transcript_error}` : ""})`)]));
    audio.addEventListener("timeupdate", () => {
      for (const span of tx.children) if (span._w) span.classList.toggle("now", audio.currentTime >= span._w.start && audio.currentTime < span._w.end);
    });
    const load = el("button", { class: "btn small", onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Loading…";
      try { await ensureAudio(rec, audio); btn.remove(); }
      catch (err) { btn.disabled = false; btn.textContent = "Retry audio"; alert(`Could not load audio: ${err.message}`); }
    } }, "Load audio");
    audioEls.set(rec.id, { audio, rec, load });
    return el("details", { class: "rec" },
      el("summary", {}, el("b", {}, recLabel(rec)), el("span", { class: "rec-meta" }, `${fmtSec(rec.duration_ms)} · ${Math.round((rec.bytes || 0) / 1024)} KB · transcript ${rec.transcript_status}`)),
      el("div", { class: "rec-body" },
        el("p", { class: "muted small" }, `${rec.chunk_count} chunks · started ${fmtSec(rec.client_started_t)} into session`),
        load, audio, tx,
        el("button", { class: "btn small", onclick: async () => { await sb.rpc("admin_reset_transcript", { p_recording: rec.id }); alert("Queued for re-transcription."); } }, "Re-transcribe")));
  };
  const recordingPanels = recordings.map(recPanel);
  async function ensureAudio(rec, audio) {
    if (!audio.src) audio.src = URL.createObjectURL(await loadRecordingAudio(rec, id));
    audioEls.get(rec.id)?.load?.remove();
  }

  const replayStatus = el("p", { class: "replay-status muted", role: "status", "aria-live": "polite" }, "Replay audio is matched automatically by timestamp.");
  const replayBox = el("div", { class: "replay-box" }, replayStatus);
  const timedRecordings = recordings
    .filter((rec) => Number.isFinite(Number(rec.client_started_wall)) && Number(rec.duration_ms) > 0)
    .sort((a, b) => Number(a.client_started_wall) - Number(b.client_started_wall));
  const recordingAt = (wallMs) => {
    let match = null;
    for (const rec of timedRecordings) {
      const start = Number(rec.client_started_wall);
      if (start > wallMs + 150) break;
      if (wallMs >= start - 150 && wallMs <= start + Number(rec.duration_ms) + 450) match = rec;
    }
    return match;
  };
  const loadReplay = el("button", { class: "btn primary", onclick: async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Loading replay…";
    replayBox.replaceChildren(replayStatus);
    replayStatus.className = "replay-status muted";
    try {
      const rr = batches.filter((b) => b.kind === "rrweb");
      if (!rr.length) throw new Error("No replay batches were uploaded for this session.");
      let processed = 0;
      replayStatus.textContent = `Loading replay files… 0 of ${rr.length}`;
      const results = await Promise.allSettled(rr.map(async (b) => {
        try {
          const blob = await q(sb.storage.from("telemetry").download(b.path));
          const parsed = JSON.parse(await blobText(blob, b.path.endsWith(".gz")));
          if (!Array.isArray(parsed.events)) throw new Error(`${b.path} does not contain replay events`);
          return parsed.events;
        } finally {
          processed++;
          replayStatus.textContent = `Loading replay files… ${processed} of ${rr.length}`;
        }
      }));
      const failed = results.filter((result) => result.status === "rejected");
      const evs = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      evs.sort((a, b) => a.timestamp - b.timestamp);
      if (evs.length < 2) throw new Error(failed[0]?.reason?.message || "The uploaded replay does not contain enough events.");
      const replayStart = evs[0].timestamp;
      const replayEnd = evs.at(-1).timestamp;
      const markerColor = (type) => /error|failed|rejection/i.test(type) ? "#dc2626"
        : /nudge|silent/i.test(type) ? "#ca8a04"
          : /trial|choice|submit/i.test(type) ? "#0e5f67"
            : /mic|speech|record/i.test(type) ? "#2563eb" : "#7c3aed";
      const eventTags = {};
      const markerEvents = events.flatMap((event) => {
        const timestamp = Number(event.client_wall || new Date(event.created_at).getTime());
        if (!Number.isFinite(timestamp) || timestamp < replayStart || timestamp > replayEnd) return [];
        const tag = event.type.replaceAll("_", " ");
        eventTags[tag] = markerColor(event.type);
        return [{ type: 5, timestamp, data: { tag, payload: event.payload || {} } }];
      });
      evs.push(...markerEvents);
      evs.sort((a, b) => a.timestamp - b.timestamp);
      const Player = window.rrwebPlayer?.default || window.rrwebPlayer;
      if (!Player) throw new Error("The replay player did not load. Reload the dashboard and try again.");
      replayStatus.textContent = timedRecordings.length ? "Loading synchronized audio…" : "No audio was recorded for this session.";
      const audioResults = await Promise.allSettled(timedRecordings.map((rec) => ensureAudio(rec, audioEls.get(rec.id).audio)));
      const failedAudio = audioResults.filter((result) => result.status === "rejected").length;
      if (seq !== navSeq) return;
      const target = el("div", { class: "replay-wrap" });
      replayBox.append(target);
      const player = new Player({ target, props: { events: evs, width: 1180, height: 700, autoPlay: false, skipInactive: true,
                                                    speedOption: [1, 2, 4, 8], tags: eventTags } });
      const first = replayStart;
      let active = null;
      let playing = false;
      let lastWall = first;
      let syncVersion = 0;
      const syncAudio = async (wallMs) => {
        const rec = recordingAt(wallMs);
        if (!rec) {
          if (active) active.audio.pause();
          active = null;
          return;
        }
        const selected = audioEls.get(rec.id);
        if (!selected) return;
        const version = ++syncVersion;
        if (active !== selected) {
          active?.audio.pause();
          active = selected;
        }
        try {
          await ensureAudio(rec, selected.audio);
          if (version !== syncVersion || active !== selected) return;
          const seconds = Math.max(0, (wallMs - Number(rec.client_started_wall)) / 1000);
          if (Math.abs(selected.audio.currentTime - seconds) > 0.6) selected.audio.currentTime = seconds;
          if (playing) selected.audio.play().catch(() => {});
        } catch (err) {
          replayStatus.className = "replay-status warn";
          replayStatus.textContent = `Replay loaded, but synchronized audio could not be loaded: ${err.message}`;
        }
      };
      player.addEventListener("ui-update-current-time", ({ payload }) => {
        lastWall = first + Number(payload || 0);
        syncAudio(lastWall);
      });
      player.addEventListener("ui-update-player-state", ({ payload }) => {
        playing = payload === "playing";
        if (playing) syncAudio(lastWall); else active?.audio.pause();
      });
      btn.remove();
      const issues = [];
      if (failed.length) issues.push(`${failed.length} of ${rr.length} replay files could not be read`);
      if (failedAudio) issues.push(`${failedAudio} audio recording${failedAudio === 1 ? "" : "s"} could not be loaded`);
      replayStatus.textContent = issues.length
        ? `Replay ready, but ${issues.join(" and ")}. ${markerEvents.length} timeline events are marked.`
        : `Replay ready · audio syncs automatically · ${markerEvents.length} timeline events marked.`;
      replayStatus.className = issues.length ? "replay-status warn" : "replay-status ok-note";
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Retry screen replay";
      replayStatus.className = "replay-status replay-error";
      replayStatus.textContent = `Could not load this replay: ${err.message}`;
    }
  } }, "Loading screen replay…");

  const t0 = session.client?.epoch_wall || created;
  const completedMs = session.completed_at ? new Date(session.completed_at).getTime() - created : null;
  const experiment = ARMS[slots.find((x) => x.slot_index === session.slot_index)?.arm] ?? "Not assigned";
  const replayBatchCount = batches.filter((b) => b.kind === "rrweb").length;
  const audioDuration = recordings.reduce((sum, rec) => sum + (Number(rec.duration_ms) || 0), 0);
  const surveyAnswers = Object.entries(surveys[0]?.answers ?? {});
  const timeline = el("div", { class: "timeline" }, ...events.map((event) => {
    const elapsed = event.client_wall ? event.client_wall - t0 : new Date(event.created_at) - created;
    return el("div", {}, `${fmtSec(elapsed)}  ${event.type}  ${JSON.stringify(event.payload).slice(0, 220)}`);
  }));
  const jump = (target, label) => el("button", { type: "button", class: "session-jump",
    onclick: () => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, label);
  viewSeq = seq;
  layout("#/sessions",
    el("header", { class: "session-head" },
      el("a", { href: "#/sessions", class: "back-link" }, "← All sessions"),
      el("div", { class: "session-title" }, el("div", {}, el("div", { class: "eyebrow" }, "Participant session"), el("h1", {}, session.prolific_pid || "No Prolific ID")),
        el("div", {}, pill(session.status, session.status === "completed" ? "good" : TERMINAL.has(session.status) ? "bad" : "info"), session.is_test ? pill("test", "info") : null))),
    el("nav", { class: "session-jumps", "aria-label": "Session sections" },
      jump("session-replay", "Replay"), jump("session-results", "Results"), jump("session-audio", "Audio & transcript"), jump("session-review", "Review"), jump("session-details", "Details")),
    el("section", { class: "panel replay-panel", id: "session-replay" },
      el("div", { class: "section-heading" },
        el("div", {}, el("div", { class: "eyebrow" }, "Session playback"), el("h2", {}, "Screen replay")),
        loadReplay),
      el("p", { class: "section-copy" }, "The replay loads automatically. Microphone audio follows it by timestamp, and colored markers on the scrubber show events from the session timeline."),
      replayBox),
    el("div", { class: "cards session-cards" },
      card("Progress", session.step || "–", `last seen ${ago(session.last_seen_at)}`),
      card("Duration", completedMs === null ? "In progress" : fmtSec(completedMs), when(session.created_at)),
      card("Experiment", experiment, `slot ${session.slot_index ?? "–"}`),
      card("Study questions", `${trials.length} / 2`, `${trials.filter((trial) => trial.correct).length} correct`),
      card("Audio", fmtSec(audioDuration), `${recordings.length} file${recordings.length === 1 ? "" : "s"}`),
      card("Replay", replayBatchCount ? `${replayBatchCount} batches` : "None", `${events.length} timeline events`)),
    el("div", { class: "section-heading page-section", id: "session-results" }, el("div", {}, el("div", { class: "eyebrow" }, "Task results"), el("h2", {}, "Study questions"))),
    ...(trialPanels.length ? trialPanels : [el("div", { class: "panel empty-state" }, "No study questions submitted yet.")]),
    el("div", { class: "section-heading page-section", id: "session-audio" }, el("div", {}, el("div", { class: "eyebrow" }, "Voice data"), el("h2", {}, "Audio and transcript")),
      el("span", { class: "muted" }, recordings.some((rec) => rec.segment === "study") ? "One recording from microphone check to final survey" : "Older task-by-task recording format")),
    el("section", { class: "panel recordings-panel" },
      ...(recordingPanels.length ? recordingPanels : [el("p", { class: "muted" }, "No recordings uploaded yet.")])),
    el("section", { class: "panel review-panel", id: "session-review" },
      el("div", { class: "section-heading" }, el("div", {}, el("div", { class: "eyebrow" }, "Research workflow"), el("h2", {}, "Review"))),
      el("div", { class: "review-grid" },
        el("div", { class: "form-row" }, el("label", {}, "Review status"), review),
        el("label", { class: "notes-field" }, el("span", {}, "Notes"), notes)),
      el("div", { class: "actions" },
        el("button", { class: "btn small primary", onclick: async () => { await sb.rpc("admin_review", { p_session: id, p_review_status: review.value, p_notes: notes.value }); alert("Saved."); } }, "Save review"),
        el("button", { class: "btn small", onclick: async () => {
          const reason = prompt("Reason for invalidating (the slot reopens for a new participant):");
          if (reason) { await sb.rpc("admin_invalidate", { p_session: id, p_reason: reason }); route(); }
        } }, "Invalidate & reopen slot"))),
    el("details", { class: "panel admin-details", id: "session-details" },
      el("summary", {}, el("b", {}, "Warm-up answers"), el("span", { class: "muted" }, ` · ${warmups.length} tasks`)),
      el("ul", {}, ...warmups.map((w) => el("li", {}, `${w.task}: "${w.answer ?? ""}", speech ${fmtSec(w.data?.speech_ms ?? null)} of ${fmtSec(w.data?.duration_ms ?? null)}, nudges ${w.data?.nudges ?? 0}`)))),
    el("details", { class: "panel admin-details" },
      el("summary", {}, el("b", {}, "Final survey"), el("span", { class: "muted" }, ` · ${surveyAnswers.length} answers`)),
      surveyAnswers.length ? el("div", { class: "kv survey-kv" }, ...surveyAnswers.flatMap(([key, value]) => [
        el("div", {}, key.replaceAll("_", " ")), el("div", {}, typeof value === "object" ? JSON.stringify(value) : String(value)),
      ])) : el("p", { class: "muted" }, "No final survey submitted yet.")),
    el("details", { class: "panel admin-details" },
      el("summary", {}, el("b", {}, "Session and device details")),
      el("div", { class: "kv details-kv" },
        el("div", {}, "Session id"), el("div", {}, session.id),
        el("div", {}, "Prolific study / session"), el("div", {}, `${session.study_id || "–"} / ${session.prolific_session_id || "–"}`),
        el("div", {}, "Slot / experiment"), el("div", {}, `${session.slot_index ?? "–"} / ${experiment}`),
        el("div", {}, "Started / completed"), el("div", {}, `${when(session.created_at)} / ${when(session.completed_at)}`),
        el("div", {}, "Browser"), el("div", {}, session.client?.ua || "–"),
        el("div", {}, "Screen / window / dpr"), el("div", {}, `${session.client?.screen?.w}×${session.client?.screen?.h} / ${session.client?.window?.w}×${session.client?.window?.h} / ${session.client?.dpr}`),
        el("div", {}, "Timezone / language"), el("div", {}, `${session.client?.timezone} / ${session.client?.language}`),
        el("div", {}, "Last heartbeat"), el("div", {}, `${ago(session.last_seen_at)}, ${JSON.stringify(session.live)}`))),
    el("details", { class: "panel admin-details" },
      el("summary", {}, el("b", {}, `Event timeline (${events.length})`)),
      timeline));
  if (seq === navSeq) queueMicrotask(() => loadReplay.click());
}

async function viewSettings() {
  const seq = navSeq;
  const cfg = await q(sb.from("config").select("*").single());
  const open = el("input", { type: "checkbox", checked: cfg.study_open });
  const code = el("input", { type: "text", value: cfg.completion_code || "" });
  const screen = el("input", { type: "text", value: cfg.screenout_code || "" });
  const nudge = el("input", { type: "number", value: cfg.nudge_silence_ms / 1000, min: 10, max: 600 });
  const resv = el("input", { type: "number", value: cfg.reservation_minutes, min: 30, max: 600 });
  const armBoxes = Object.entries(ARMS).map(([arm, name]) => [arm, name, el("input", { type: "checkbox", checked: cfg.open_arms.includes(arm) })]);
  const arms = el("span", { class: "arm-boxes" }, ...armBoxes.map(([, name, box]) => el("label", {}, box, ` ${name}`)));
  const save = el("button", { class: "btn primary", onclick: async () => {
    await q(sb.rpc("admin_update_config", { p_patch: { study_open: open.checked, completion_code: code.value.trim(), screenout_code: screen.value.trim(),
      nudge_silence_ms: Math.round(Number(nudge.value) * 1000), reservation_minutes: Number(resv.value),
      open_arms: armBoxes.filter(([, , box]) => box.checked).map(([arm]) => arm) } }));
    alert("Saved.");
    route();
  } }, "Save settings");
  const row = (label, input, help = "") => el("div", { class: "form-row" }, el("label", {}, label), input, el("span", { class: "muted" }, help));
  viewSeq = seq;
  layout("#/settings", el("h2", {}, "Settings"), el("div", { class: "panel" },
    row("Study open", open, "Real Prolific participants can start only when open. TEST_ ids always work."),
    row("Open experiments", arms, "New participants are assigned only to these, taking turns in slot order"),
    row("Completion code", code, "From your Prolific study page"),
    row("Screen-out code", screen, "Optional (Prolific screen-out / no-mic)"),
    row("Nudge after silence (s)", nudge),
    row("Slot reservation (min)", resv, "Abandoned slots are released after this"),
    el("div", { class: "actions" }, save)),
    el("h2", {}, "Participant link for Prolific"),
    el("div", { class: "panel" }, el("code", {}, `${location.origin}${location.pathname.replace(/admin\.html$/, "")}index.html?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`),
      el("p", { class: "muted" }, "Test it yourself with ", el("code", {}, "index.html?test=1"), " (creates a TEST_ session that never uses a real slot).")));
}

async function viewExport() {
  const seq = navSeq;
  const tables = ["sessions", "trials", "warmups", "surveys", "recordings", "transcripts", "session_events", "slots", "items", "telemetry_batches"];
  const buttons = tables.map((t) => el("button", { class: "btn small", onclick: async (e) => {
    e.target.disabled = true;
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const chunk = await q(sb.from(t).select("*").range(from, from + 999));
      rows.push(...chunk);
      if (chunk.length < 1000) break;
    }
    download(`${t}.json`, JSON.stringify(rows, null, 1), "application/json");
    download(`${t}.csv`, toCsv(rows), "text/csv");
    e.target.disabled = false;
  } }, t));
  viewSeq = seq;
  layout("#/export", el("h2", {}, "Export"), el("div", { class: "panel" },
    el("p", {}, "Download any table as JSON + CSV (includes TEST_ sessions; filter on is_test):"), el("div", { class: "actions" }, ...buttons),
    el("p", { class: "muted" }, "Audio and telemetry files are not in these tables. A full offline backup needs the export script, which is kept outside the repo.")));
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

async function route() {
  clearInterval(state.timer);
  const seq = ++navSeq;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return login();
  const hash = location.hash || "#/overview";
  try {
    if (hash.startsWith("#/session/")) await viewSession(hash.slice("#/session/".length));
    else if (hash === "#/sessions") await viewSessions();
    else if (hash === "#/settings") await viewSettings();
    else if (hash === "#/export") await viewExport();
    else {
      await viewOverview();
      state.timer = setInterval(() => { if (!document.hidden && seq === navSeq) viewOverview().catch(() => {}); }, 15000);
    }
  } catch (err) {
    if (/JWT|not authenticated|invalid claim/i.test(err.message)) return login("Session expired, please sign in again.");
    viewSeq = seq;
    layout(hash, el("div", { class: "warn" }, `Error: ${err.message}`));
  }
}

addEventListener("hashchange", route);
route();
