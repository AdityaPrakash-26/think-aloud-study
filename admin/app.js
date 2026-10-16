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
const STATUSES = ["started", "consented", "mic_ok", "warmup_done", "in_trials", "post_survey", "completed", "screened_out", "declined", "invalidated"];

function card(k, v, s = "") {
  return el("div", { class: "card" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), s ? el("div", { class: "s" }, s) : null);
}
function table(headers, rows, onClick = null) {
  return el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, ...rows.map((r) => {
      const tr = el("tr", onClick ? { class: "click", onclick: () => onClick(r) } : {}, ...r.cells.map((c) => el("td", {}, c)));
      return tr;
    })));
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

function layout(active, ...body) {
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
    q(sb.from("images").select("path").limit(2000)),
    q(sb.from("surveys").select("*")),
    q(sb.from("session_events").select("session_id,type").in("type", ["resume", "nudge", "mic_check", "upload_drain", "vad_fallback", "js_error", "js_rejection"]).limit(20000)),
  ]);
  const keep = (s) => state.includeTests || !s.is_test;
  const shown = sessions.filter(keep);
  const ids = new Set(shown.map((s) => s.id));
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
  const d = await loadCore();
  const warnings = [];
  if (!d.config.study_open) warnings.push("The study is CLOSED: real participants see “not open”. Open it in Settings when you launch.");
  if (!d.config.completion_code) warnings.push("No Prolific completion code is set (Settings).");
  if (d.images.some((i) => i.path.includes("placeholder"))) warnings.push("Image trials are using PLACEHOLDER images (old Gemini images). Publish the FLUX images before launch.");
  if (!d.images.length) warnings.push("No images are registered: image trials cannot run.");

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

  const itemRows = d.items.map((it) => {
    const ts = d.trials.filter((t) => t.item_index === it.item_index && t.submitted_at);
    const cell = (cond) => { const x = ts.filter((t) => t.condition === cond); return `${x.length} (${fmtPct(mean(x.map((t) => (t.correct ? 1 : 0))))})`; };
    return { cells: [it.item_index, it.dataset, it.record_id, `${it.meta?.words_a ?? "?"} / ${it.meta?.words_b ?? "?"}`, it.gold.toUpperCase(), cell("text"), cell("image")] };
  });

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
    el("h2", {}, "Items"),
    table(["#", "Dataset", "Record", "Words A / B", "Gold", "Text trials (acc.)", "Image trials (acc.)"], itemRows),
    el("h2", {}, "Transcription"),
    el("div", { class: "panel" }, `pending ${tq.pending} · processing ${tq.processing} · done ${tq.done} · skipped ${tq.skipped} · errors ${tq.error}  `,
      el("button", { class: "btn small", onclick: async (e) => { e.target.disabled = true; await sb.rpc("admin_transcribe_now"); e.target.textContent = "Triggered"; } }, "Transcribe now")));
}

async function viewSessions() {
  const d = await loadCore();
  const rows = d.sessions.map((s) => {
    const ts = d.trials.filter((t) => t.session_id === s.id).sort((a, b) => a.trial_index - b.trial_index);
    const survey = d.surveys.find((x) => x.session_id === s.id);
    const flags = flagsFor(s, ts, survey, d.events);
    const duration = s.completed_at ? new Date(s.completed_at) - new Date(s.created_at) : null;
    return {
      s,
      cells: [
        el("span", {}, s.prolific_pid || "–", s.is_test ? pill("test", "info") : null),
        pill(s.status, s.status === "completed" ? "good" : TERMINAL.has(s.status) ? "bad" : "info"),
        s.step, when(s.created_at), duration ? fmtSec(duration) : `seen ${ago(s.last_seen_at)}`, s.slot_index ?? "–",
        el("span", {}, ...ts.map((t) => pill(`${t.trial_index}:${t.condition}${t.correct === null ? "" : t.correct ? " ✓" : " ✗"}`, t.correct ? "good" : "bad"))),
        el("span", {}, ...ts.map((t) => `${fmtPct(num(t.speech_ratio))} `)),
        el("span", {}, ...flags.map(([text, kind]) => pill(text, kind))),
        pill(s.review_status, s.review_status === "approved" ? "good" : s.review_status === "rejected" ? "bad" : ""),
      ],
    };
  });
  layout("#/sessions", el("h2", {}, `Sessions (${rows.length})`),
    table(["Prolific ID", "Status", "Step", "Started", "Duration", "Slot", "Trials", "Speech", "Flags", "Review"], rows,
      (r) => { location.hash = `#/session/${r.s.id}`; }));
}

async function loadRecordingAudio(rec, sessionId) {
  const prefix = `${sessionId}/${rec.id}`;
  const files = await q(sb.storage.from("recordings").list(prefix, { limit: 2000, sortBy: { column: "name", order: "asc" } }));
  const parts = [];
  for (const f of files) parts.push(await q(sb.storage.from("recordings").download(`${prefix}/${f.name}`)));
  return new Blob(parts, { type: (rec.mime || "audio/webm").split(";")[0] });
}

async function viewSession(id) {
  const [session, events, trials, warmups, surveys, recordings, batches] = await Promise.all([
    q(sb.from("sessions").select("*").eq("id", id).single()),
    q(sb.from("session_events").select("*").eq("session_id", id).order("id").limit(5000)),
    q(sb.from("trials").select("*").eq("session_id", id).order("trial_index")),
    q(sb.from("warmups").select("*").eq("session_id", id)),
    q(sb.from("surveys").select("*").eq("session_id", id)),
    q(sb.from("recordings").select("*, transcripts(*)").eq("session_id", id).order("created_at")),
    q(sb.from("telemetry_batches").select("*").eq("session_id", id).order("seq")),
  ]);
  const created = new Date(session.created_at).getTime();
  const notes = el("textarea", { rows: 2 }, session.admin_notes || "");
  const review = el("select", {}, ...["unreviewed", "approved", "rejected", "flagged"].map((v) => el("option", { value: v, selected: v === session.review_status }, v)));

  const trialPanels = trials.map((t) => {
    const marks = (t.data?.annotations?.marks || []).filter((m) => !m.deleted_t);
    return el("div", { class: "panel" },
      el("h3", {}, `Trial ${t.trial_index}: ${t.condition} — item ${t.item_index} — chose ${t.choice_side?.toUpperCase()} `, t.correct ? pill("correct", "good") : pill("wrong", "bad")),
      el("div", { class: "kv" },
        el("div", {}, "Confidence"), el("div", {}, t.confidence ?? "–"),
        el("div", {}, "Time (total / active)"), el("div", {}, `${fmtSec(t.data?.total_ms ?? null)} / ${fmtSec(t.data?.active_ms ?? null)}`),
        el("div", {}, "Speech / nudges"), el("div", {}, `${fmtPct(t.data?.speech_ratio ?? null)} / ${t.data?.nudges ?? 0}`),
        el("div", {}, "Tab hidden / blurred"), el("div", {}, `${fmtSec(t.data?.hidden_ms ?? null)} (${t.data?.hidden_count ?? 0}×) / ${fmtSec(t.data?.blur_ms ?? null)}`),
        el("div", {}, "Choice changes"), el("div", {}, t.data?.choice_changes ?? 0),
        el("div", {}, "Image variants"), el("div", {}, t.data?.variants ? JSON.stringify(t.data.variants) : "–"),
        el("div", {}, "Panes"), el("div", {}, JSON.stringify(t.data?.annotations?.panes ?? {})),
        el("div", {}, "TLX"), el("div", {}, t.tlx ? Object.entries(t.tlx).map(([k, v]) => `${k}: ${v}`).join(" · ") : "–")),
      el("h3", { style: "margin-top:10px" }, `Marks (${marks.length})`),
      el("ul", { class: "marks" }, ...marks.map((m) => el("li", {},
        pill(m.valence || m.tool, m.valence === "good" ? "good" : m.valence === "bad" ? "bad" : m.valence === "unsure" ? "warn" : "info"),
        ` ${m.pane} (${m.side?.toUpperCase()}) ${m.kind} @${fmtSec(m.created_t - (t.data?.started_t ?? 0))}: `,
        m.kind === "text_highlight" ? `“${m.text}”` : m.kind === "note" ? `note: “${m.text}”` : `${m.points?.length} pts, bbox ${JSON.stringify(m.bbox)}`))));
  });

  const audioEls = new Map();
  const recPanels = recordings.map((rec) => {
    const audio = el("audio", { controls: true, preload: "none" });
    audioEls.set(rec.id, { audio, rec });
    const tr = rec.transcripts?.[0] || (Array.isArray(rec.transcripts) ? null : rec.transcripts);
    const words = tr?.words || [];
    const tx = el("div", { class: "transcript" }, ...(words.length ? words.map((w) => {
      const span = el("span", { class: "w", title: `${w.start}s` }, w.word);
      span.addEventListener("click", async () => { await ensureAudio(rec, audio); audio.currentTime = w.start; audio.play(); });
      span._w = w;
      return span;
    }) : [el("span", { class: "muted" }, tr?.text || `(transcript: ${rec.transcript_status}${rec.transcript_error ? ` — ${rec.transcript_error}` : ""})`)]));
    audio.addEventListener("timeupdate", () => {
      for (const span of tx.children) if (span._w) span.classList.toggle("now", audio.currentTime >= span._w.start && audio.currentTime < span._w.end);
    });
    const load = el("button", { class: "btn small", onclick: async (e) => { e.target.disabled = true; await ensureAudio(rec, audio); e.target.remove(); } }, "Load audio");
    return el("div", { class: "rec" },
      el("b", {}, `${rec.segment}${rec.part ? ` (part ${rec.part + 1})` : ""}`), ` — ${fmtSec(rec.duration_ms)} · ${Math.round(rec.bytes / 1024)} KB · ${rec.chunk_count} chunks · started ${fmtSec(rec.client_started_t)} into session · transcript ${rec.transcript_status} `,
      load, audio, tx,
      el("button", { class: "btn small", onclick: async () => { await sb.rpc("admin_reset_transcript", { p_recording: rec.id }); alert("Queued for re-transcription."); } }, "Re-transcribe"));
  });
  async function ensureAudio(rec, audio) {
    if (audio.src) return;
    audio.src = URL.createObjectURL(await loadRecordingAudio(rec, id));
  }

  const replayBox = el("div", {});
  const syncSelect = el("select", {}, el("option", { value: "" }, "(no audio sync)"), ...recordings.map((r) => el("option", { value: r.id }, `${r.segment}${r.part ? ` p${r.part + 1}` : ""}`)));
  const loadReplay = el("button", { class: "btn small", onclick: async (e) => {
    e.target.disabled = true; e.target.textContent = "Loading replay…";
    const rr = batches.filter((b) => b.kind === "rrweb");
    const evs = [];
    for (const b of rr) {
      const blob = await q(sb.storage.from("telemetry").download(b.path));
      evs.push(...JSON.parse(await blobText(blob, b.path.endsWith(".gz"))).events);
    }
    evs.sort((a, b) => a.timestamp - b.timestamp);
    e.target.remove();
    if (evs.length < 2) { replayBox.append(el("p", { class: "muted" }, "No replay data.")); return; }
    const Player = window.rrwebPlayer?.default || window.rrwebPlayer;
    const target = el("div", { class: "replay-wrap" });
    replayBox.append(target);
    const player = new Player({ target, props: { events: evs, width: 1100, height: 640, autoPlay: false, skipInactive: true, speedOption: [1, 2, 4, 8] } });
    const first = evs[0].timestamp;
    player.addEventListener("ui-update-current-time", ({ payload }) => {
      const sel = audioEls.get(syncSelect.value);
      if (!sel || !sel.audio.src) return;
      const target = (first + payload - sel.rec.client_started_wall) / 1000;
      if (target >= 0 && Math.abs(sel.audio.currentTime - target) > 0.6) sel.audio.currentTime = target;
    });
    player.addEventListener("ui-update-player-state", async ({ payload }) => {
      const sel = audioEls.get(syncSelect.value);
      if (!sel) return;
      await ensureAudio(sel.rec, sel.audio);
      if (payload === "playing") sel.audio.play().catch(() => {}); else sel.audio.pause();
    });
  } }, "Load screen replay");

  const t0 = session.client?.epoch_wall || created;
  layout("#/sessions",
    el("p", {}, el("a", { href: "#/sessions" }, "← all sessions")),
    el("h2", {}, `Session ${session.prolific_pid || ""} `, pill(session.status), session.is_test ? pill("test", "info") : null),
    el("div", { class: "two" },
      el("div", { class: "panel" }, el("h3", {}, "Session"), el("div", { class: "kv" },
        el("div", {}, "Session id"), el("div", {}, session.id),
        el("div", {}, "Prolific study / session"), el("div", {}, `${session.study_id || "–"} / ${session.prolific_session_id || "–"}`),
        el("div", {}, "Slot"), el("div", {}, session.slot_index ?? "–"),
        el("div", {}, "Started / completed"), el("div", {}, `${when(session.created_at)} / ${when(session.completed_at)}`),
        el("div", {}, "Browser"), el("div", {}, session.client?.ua || "–"),
        el("div", {}, "Screen / window / dpr"), el("div", {}, `${session.client?.screen?.w}×${session.client?.screen?.h} / ${session.client?.window?.w}×${session.client?.window?.h} / ${session.client?.dpr}`),
        el("div", {}, "Timezone / language"), el("div", {}, `${session.client?.timezone} / ${session.client?.language}`),
        el("div", {}, "Last heartbeat"), el("div", {}, `${ago(session.last_seen_at)} — ${JSON.stringify(session.live)}`))),
      el("div", { class: "panel" }, el("h3", {}, "Review"), el("div", { class: "form-row" }, el("label", {}, "Status"), review), notes,
        el("div", { class: "actions" },
          el("button", { class: "btn small primary", onclick: async () => { await sb.rpc("admin_review", { p_session: id, p_review_status: review.value, p_notes: notes.value }); alert("Saved."); } }, "Save review"),
          el("button", { class: "btn small", onclick: async () => {
            const reason = prompt("Reason for invalidating (the slot reopens for a new participant):");
            if (reason) { await sb.rpc("admin_invalidate", { p_session: id, p_reason: reason }); route(); }
          } }, "Invalidate & reopen slot")),
        el("h3", { style: "margin-top:14px" }, "Warm-ups"),
        el("ul", {}, ...warmups.map((w) => el("li", {}, `${w.task}: “${w.answer ?? ""}” — speech ${fmtSec(w.data?.speech_ms ?? null)} of ${fmtSec(w.data?.duration_ms ?? null)}, nudges ${w.data?.nudges ?? 0}`))),
        el("h3", {}, "Survey"), el("pre", { class: "small" }, JSON.stringify(surveys[0]?.answers ?? {}, null, 1)))),
    el("h2", {}, "Trials"), ...trialPanels,
    el("h2", {}, "Recordings & transcripts"), el("div", { class: "panel" }, ...recPanels),
    el("h2", {}, "Screen replay"), el("div", { class: "panel" }, el("div", { class: "form-row" }, el("label", {}, "Play audio along with replay"), syncSelect), loadReplay, replayBox),
    el("h2", {}, `Timeline (${events.length} events)`),
    el("div", { class: "panel timeline" }, ...events.map((e) => el("div", {},
      `${fmtSec(e.client_wall ? e.client_wall - t0 : new Date(e.created_at) - created)}  ${e.type}  ${JSON.stringify(e.payload).slice(0, 220)}`))));
}

async function viewSettings() {
  const cfg = await q(sb.from("config").select("*").single());
  const open = el("input", { type: "checkbox", checked: cfg.study_open });
  const code = el("input", { type: "text", value: cfg.completion_code || "" });
  const screen = el("input", { type: "text", value: cfg.screenout_code || "" });
  const nudge = el("input", { type: "number", value: cfg.nudge_silence_ms / 1000, min: 10, max: 600 });
  const resv = el("input", { type: "number", value: cfg.reservation_minutes, min: 30, max: 600 });
  const save = el("button", { class: "btn primary", onclick: async () => {
    await q(sb.rpc("admin_update_config", { p_patch: { study_open: open.checked, completion_code: code.value.trim(), screenout_code: screen.value.trim(),
      nudge_silence_ms: Math.round(Number(nudge.value) * 1000), reservation_minutes: Number(resv.value) } }));
    alert("Saved.");
    route();
  } }, "Save settings");
  const row = (label, input, help = "") => el("div", { class: "form-row" }, el("label", {}, label), input, el("span", { class: "muted" }, help));
  layout("#/settings", el("h2", {}, "Settings"), el("div", { class: "panel" },
    row("Study open", open, "Real Prolific participants can start only when open. TEST_ ids always work."),
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
  layout("#/export", el("h2", {}, "Export"), el("div", { class: "panel" },
    el("p", {}, "Download any table as JSON + CSV (includes TEST_ sessions; filter on is_test):"), el("div", { class: "actions" }, ...buttons),
    el("p", { class: "muted" }, "For a complete offline backup including all audio and telemetry files, run ", el("code", {}, "python study/tools/export_all.py"), " on your computer.")));
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

async function route() {
  clearInterval(state.timer);
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
      state.timer = setInterval(() => { if (!document.hidden) viewOverview().catch(() => {}); }, 15000);
    }
  } catch (err) {
    if (/JWT|not authenticated|invalid claim/i.test(err.message)) return login("Session expired, please sign in again.");
    layout(hash, el("div", { class: "warn" }, `Error: ${err.message}`));
  }
}

addEventListener("hashchange", route);
route();
