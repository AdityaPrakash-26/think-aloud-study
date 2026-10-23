// Participant app entry point: session start/resume, step routing, audio
// pipeline wiring, heartbeat.

import { CONFIG } from "./config.js";
import { Api } from "./api.js";
import { Outbox } from "./outbox.js";
import { Telemetry } from "./telemetry.js";
import { Mic, Recorder } from "./media.js";
import { SpeechDetector, Nudger } from "./vad.js";
import { show, page, para, button, waitClick, toast, showNudge, hideNudge, errorBox, setStage } from "./ui.js";
import { el, clientInfo, sleep, t } from "./util.js";
import * as steps from "./steps.js";

const telemetry = new Telemetry();
telemetry.start(); // buffers until the session exists

const STATUS_FOR_STEP = { tutorial: "warmup_done", trial_1: "in_trials", survey: "post_survey" };
const NEEDS_AUDIO = new Set(["instructions", "warmup_multiply", "warmup_windows", "warmup_animals", "tutorial",
                             "trial_1", "tlx_1", "trial_2", "tlx_2", "survey"]);

function terminal(title, ...body) {
  show(page(title, ...body));
}

async function askForPid() {
  const input = el("input", { type: "text", class: "answer", placeholder: "Your Prolific ID", "data-tid": "pid-input" });
  const go = button("Continue", null, { tid: "pid-go", disabled: true });
  input.addEventListener("input", () => { go.disabled = input.value.trim().length < 6; });
  show(page("Welcome", para("Enter your Prolific ID to get started."), input, el("div", { class: "actions" }, go)));
  await waitClick(go);
  return input.value.trim();
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const test = params.has("test");
  let pid = params.get("PROLIFIC_PID");
  if (!pid && test) pid = `TEST_${crypto.randomUUID().slice(0, 8)}`;
  if (!pid) pid = await askForPid();

  const api = new Api();
  show(page("Loading…"));
  let start;
  try {
    start = await api.call("start_session", {
      p_prolific_pid: pid, p_study_id: params.get("STUDY_ID"), p_prolific_session_id: params.get("SESSION_ID"),
      p_client: { ...clientInfo(), url_params: Object.fromEntries(params) },
    });
  } catch (err) {
    telemetry.log("start_failed", { msg: String(err?.message || err) });
    return terminal("We couldn't connect", errorBox("Check your internet connection, then reload this page."));
  }
  if (start.outcome === "closed") {
    return terminal("This study is closed", para("Please return the study on Prolific. Thank you for your interest."));
  }
  if (start.outcome === "already_finished") {
    return terminal("You have already taken part", para("Our records show that you already completed or left this study, so you cannot take it again. Thank you."));
  }

  api.setSession(start.session_id, start.token);
  const outbox = new Outbox(api);
  const leftover = await outbox.open();
  telemetry.attach({ outbox, sessionId: start.session_id });
  telemetry.log("session", { outcome: start.outcome, step: start.step, pid_is_test: pid.startsWith("TEST_"), leftover_jobs: leftover }, { milestone: true });

  let currentStep = start.step;
  const ctx = {
    api, outbox, telemetry, test, pid,
    plan: start.plan || null,
    // TEST_ sessions may shorten the silence threshold (?test&nudge_ms=5000) for QA.
    nudgeMs: (pid.startsWith("TEST_") && Number(params.get("nudge_ms"))) || start.nudge_silence_ms || CONFIG.defaultNudgeSilenceMs,
    mic: null, detector: null, recorder: null, nudger: null,

    async ensureAudio() {
      if (ctx.mic) return;
      const mic = new Mic(telemetry);
      await mic.open();
      const detector = new SpeechDetector(mic, telemetry);
      await detector.start();
      const recorder = new Recorder({ mic, outbox, sessionId: start.session_id, telemetry });
      const nudger = new Nudger(detector, telemetry, {
        thresholdMs: ctx.nudgeMs,
        onNudge: () => showNudge("Please keep talking. Say what you are thinking out loud."),
        onResume: hideNudge,
      });
      mic.listeners.add(({ type }) => {
        if (type === "ended") toast("Your microphone stopped working. Check that it is still connected.", { ms: 15000 });
      });
      Object.assign(ctx, { mic, detector, recorder, nudger });
    },

    async setStep(step, status = null, payload = {}) {
      currentStep = step;
      telemetry.setContext({ step });
      try {
        await api.call("set_step", { p_step: step, p_status: status, p_payload: payload, p_client_t: t() });
      } catch (err) {
        telemetry.log("set_step_error", { step, msg: String(err?.message || err) }, { milestone: true });
      }
    },

    // Keep retrying important writes; tell the participant if the connection is down.
    async reliably(fn, args) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await api.call(fn, args, 3);
        } catch (err) {
          telemetry.log("rpc_retry", { fn, attempt, msg: String(err?.message || err) }, { milestone: true });
          if (!err.transient && attempt >= 2) throw err;
          toast("We lost the connection and are trying again. Keep this page open.", { ms: 8000 });
          await sleep(Math.min(30000, 2000 * 2 ** attempt));
        }
      }
    },

    async screenOut(reason, status, {
      title = "Sorry, you can't continue",
      body = "It looks like your microphone isn't working, so you can't take part in this study.",
    } = {}) {
      ctx.nudger?.deactivate();
      if (ctx.recorder?.isRecording()) await ctx.recorder.stop();
      await telemetry.flush();
      await outbox.drain(15000);
      let result = null;
      try { result = await api.call("screen_out", { p_reason: reason, p_status: status }); } catch { /* still show the page */ }
      ctx.mic?.close();
      currentStep = "screened_out";
      if (status === "declined") {
        return terminal("Thank you", para('You chose not to take part. Please return the study on Prolific by clicking "Return submission".'));
      }
      return terminal(title, para(body),
        result?.screenout_url
          ? el("div", { class: "actions" }, el("a", { class: "btn primary", href: result.screenout_url }, "Return to Prolific"))
          : para("Please return the study on Prolific. Sorry for the trouble."));
    },
  };

  setInterval(() => {
    const p = outbox.pending();
    api.rpc("heartbeat", { p_live: {
      step: currentStep, t: Math.round(t()), visible: !document.hidden, focused: document.hasFocus(),
      speaking: ctx.detector?.speaking ?? null, vad: ctx.detector?.mode ?? null,
      level_db: ctx.mic?.lastDb !== undefined ? Math.round(ctx.mic.lastDb) : null,
      speech_ms: ctx.detector ? ctx.detector.speechMs() : null, nudges: ctx.nudger?.count ?? 0,
      rec: ctx.recorder ? { ...ctx.recorder.stats } : null,
      outbox: { jobs: p.jobs, dead: p.dead, bytes: p.bytes, ok: p.ok, failed_attempts: p.failedAttempts, last_ok: p.lastOkWall, last_error: p.lastError },
    } }).catch(() => {});
  }, CONFIG.heartbeatMs);

  addEventListener("beforeunload", (e) => {
    if (["done", "screened_out"].includes(currentStep)) return;
    telemetry.log("beforeunload", {}, { milestone: true });
    telemetry.flush();
    e.preventDefault();
    e.returnValue = "";
  });

  const order = steps.STEP_ORDER;
  let index = Math.max(0, order.indexOf(start.step));
  if (start.outcome === "resumed" && index > 0) telemetry.log("resume_at", { step: start.step }, { milestone: true });

  for (; index < order.length; index++) {
    const step = order[index];
    setStage(step);
    await ctx.setStep(step, STATUS_FOR_STEP[step] ?? null);
    if (NEEDS_AUDIO.has(step) && !ctx.mic) {
      const resume = button("Turn my microphone back on", null, { tid: "mic-resume" });
      show(page("Welcome back", para("Your progress is saved. Turn your microphone back on to continue."),
        el("div", { class: "actions" }, resume)));
      await waitClick(resume);
      try { await ctx.ensureAudio(); } catch {
        return ctx.screenOut("microphone unavailable after resume", "screened_out");
      }
    }
    if ((step === "trial_1" || step === "trial_2") && !ctx.plan) {
      const claim = await ctx.reliably("claim_slot", {});
      if (claim.outcome !== "assigned") {
        telemetry.log("no_slot", { outcome: claim.outcome }, { milestone: true });
        return ctx.screenOut("study full", "screened_out", {
          title: "This study is full",
          body: "All places have been filled. Please return the study on Prolific. Sorry for the trouble.",
        });
      }
      ctx.plan = claim.plan;
    }
    const n = step.endsWith("_1") ? 1 : 2;
    let result;
    switch (step) {
      case "landing": result = await steps.landing(ctx); break;
      case "consent": result = await steps.consent(ctx); break;
      case "mic": result = await steps.micCheck(ctx); break;
      case "instructions": result = await steps.instructions(ctx); break;
      case "warmup_multiply": result = await steps.warmup(ctx, "multiply"); break;
      case "warmup_windows": result = await steps.warmup(ctx, "windows"); break;
      case "warmup_animals": result = await steps.warmup(ctx, "animals"); break;
      case "tutorial": result = await steps.tutorial(ctx); break;
      case "trial_1": case "trial_2": result = await steps.trial(ctx, ctx.plan.trials[n - 1]); break;
      case "tlx_1": case "tlx_2": result = await steps.tlx(ctx, n, ctx.plan.trials[n - 1]); break;
      case "survey": result = await steps.survey(ctx); break;
      case "done": result = await steps.done(ctx); currentStep = "done"; break;
    }
    if (result === "stop") return;
  }
}

boot().catch((err) => {
  telemetry.log("fatal", { msg: String(err?.message || err), stack: String(err?.stack || "").slice(0, 2000) }, { milestone: true });
  telemetry.flush();
  show(page("Something went wrong", errorBox("Reload the page to try again. Your progress is saved. If this keeps happening, message the researchers on Prolific."),
    el("pre", { class: "muted small" }, String(err?.message || err))));
});
