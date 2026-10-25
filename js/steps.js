// Participant flow. Each step renders a screen and resolves when the participant
// moves on. Order (STEP_ORDER) is persisted server-side so reloads resume.

import { CONFIG } from "./config.js";
import { brToNewline, el, t, sleep } from "./util.js";
import { show, page, para, button, waitClick, topbar, toast, likert, scaleSlider, errorBox } from "./ui.js";
import { Annotator } from "./annotate.js";
import { PRACTICE } from "./practice.js";

export const STEP_ORDER = [
  "landing", "consent", "mic", "instructions",
  "warmup_multiply", "warmup_windows", "warmup_animals", "tutorial",
  "trial_1", "tlx_1", "trial_2", "tlx_2", "survey", "done",
];

// ---------------------------------------------------------------------------
// Landing + device check
// ---------------------------------------------------------------------------

function deviceChecks() {
  const ua = navigator.userAgent;
  const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || navigator.userAgentData?.mobile === true;
  return [
    { id: "desktop", label: "A laptop or desktop (no phones or tablets)", ok: !mobile, hard: true },
    { id: "audio", label: "Chrome, Edge, or Firefox with microphone access", ok: Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode), hard: true },
    { id: "storage", label: "An up-to-date browser", ok: Boolean(window.indexedDB && typeof CompressionStream !== "undefined" && crypto.randomUUID), hard: true },
    { id: "width", label: `A browser window at least ${CONFIG.minWindowWidth} pixels wide (maximize it)`, ok: innerWidth >= CONFIG.minWindowWidth, hard: false },
  ];
}

export async function landing(ctx) {
  const list = el("ul", { class: "checks" });
  const start = button("Start", null, { tid: "start" });
  const refresh = () => {
    const checks = deviceChecks();
    list.replaceChildren(...checks.map((c) => el("li", { class: c.ok ? "ok" : "bad" }, el("span", { class: "mark", "aria-hidden": "true" }, c.ok ? "✓" : "✗"),
      el("span", {}, c.label, c.ok ? "" : " (needs attention)"))));
    start.disabled = !checks.every((c) => c.ok);
    return checks;
  };
  addEventListener("resize", refresh);
  const checks = refresh();
  ctx.telemetry.log("device_checks", { checks: checks.map((c) => [c.id, c.ok]) }, { milestone: true });
  const plan = [
    ["Set up", "Read about the study and check your microphone."],
    ["Warm up & practice", "Get comfortable thinking aloud and try the annotation tools."],
    ["Experiment", "Compare two pairs of answers: one shown as text and one as images."],
    ["Final survey", "Tell us how it went."],
  ];
  show(page("Comparing answers",
    para("You'll see <b>two questions</b>. Each one has <b>two answers</b>; choose the better answer. One comparison uses text and the other uses images."),
    para("As you work, <b>say what you're thinking out loud</b>. We'll record your voice."),
    el("ol", { class: "plan" }, ...plan.map(([title, text], i) => el("li", {}, el("span", { class: "n" }, String(i + 1)), el("div", {}, el("b", {}, title), el("span", {}, text))))),
    el("h2", {}, "Before you start"),
    el("ul", {}, el("li", {}, "A working microphone and a quiet place"), el("li", {}, `About ${CONFIG.estimatedMinutes} minutes without interruptions`)),
    list,
    el("div", { class: "actions" }, start)));
  await waitClick(start);
  removeEventListener("resize", refresh);
  ctx.telemetry.log("device_checks_passed", { checks: deviceChecks().map((c) => [c.id, c.ok]) }, { milestone: true });
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export async function consent(ctx) {
  const adult = el("input", { type: "checkbox", id: "c-adult", "data-tid": "consent-adult" });
  const agree = el("input", { type: "checkbox", id: "c-agree", "data-tid": "consent-agree" });
  const yes = button("I agree", null, { tid: "consent-yes", disabled: true });
  const no = button("I do not agree", null, { primary: false, tid: "consent-no" });
  const update = () => { yes.disabled = !(adult.checked && agree.checked); };
  adult.addEventListener("change", update);
  agree.addEventListener("change", update);
  show(page("Information and consent",
    el("div", { class: "consent" },
      el("h2", {}, "What this study is about"),
      para("We want to understand how people judge answers and whether it makes a difference when an answer is shown as an <b>image</b> instead of <b>text</b>."),
      el("h2", {}, "What you will do"),
      para("You'll warm up, learn the annotation tools, compare two pairs of answers, and complete a few short questionnaires. Please <b>think aloud</b> throughout. The study takes about " + CONFIG.estimatedMinutes + " minutes."),
      el("h2", {}, "What we record"),
      el("ul", {},
        el("li", {}, "Your voice, from the microphone check to the end of the study."),
        el("li", {}, "What you do on this page, including mouse movements, clicks, scrolling, typing, highlights, drawings, and notes. We also make a replay of the page as you saw it."),
        el("li", {}, "Your choices, ratings, and basic browser details.")),
      para("We do <b>not</b> record your camera, anything outside this page, or your other tabs and apps."),
      el("h2", {}, "How your data is used"),
      para("We store the recordings securely and use a cloud speech-recognition service to transcribe them. Only the research team can access this data. We may publish anonymized results, including short quotes from what you said. We use your Prolific ID only to manage payment and never publish it."),
      el("h2", {}, "Your rights"),
      para("Taking part is your choice. You can stop at any time by closing this window and returning the study on Prolific. The risks are no greater than everyday computer use. If you have questions, message the researchers through Prolific."),
      el("label", { class: "check" }, adult, " I am 18 or older."),
      el("label", { class: "check" }, agree, " I have read this page and agree to take part, including having my voice and activity on this page recorded.")),
    el("div", { class: "actions" }, no, yes)));
  const choice = await Promise.race([waitClick(yes).then(() => "yes"), waitClick(no).then(() => "no")]);
  if (choice === "no") {
    await ctx.screenOut("declined consent", "declined");
    return "stop";
  }
  await ctx.setStep("consent", "consented", { adult: true, agree: true });
}

// ---------------------------------------------------------------------------
// Microphone check
// ---------------------------------------------------------------------------

export async function micCheck(ctx) {
  const status = el("div", { class: "mic-status" });
  const allow = button("Allow microphone", null, { tid: "mic-allow" });
  show(page("Microphone check",
    para("Click below, then choose <b>Allow</b> when your browser asks to use your microphone."),
    status, el("div", { class: "actions" }, allow)));

  for (;;) {
    await waitClick(allow);
    allow.disabled = true;
    status.replaceChildren(el("p", {}, "Waiting for permission…"));
    try {
      await ctx.ensureAudio();
      break;
    } catch (err) {
      ctx.telemetry.log("mic_error", { name: err?.name, msg: String(err?.message || err) }, { milestone: true });
      const blocked = err?.name === "NotAllowedError";
      status.replaceChildren(errorBox(blocked
        ? "Microphone access is blocked. Use the lock or microphone icon in the address bar to allow it, then try again."
        : "We could not find a working microphone. Connect one, then try again."));
      allow.disabled = false;
    }
  }
  if (!ctx.recorder.isRecording()) {
    ctx.recorder.start("study");
    ctx.telemetry.log("continuous_recording_started", { step: "mic" }, { milestone: true });
  }

  const sentence = "I am ready to think aloud while I work.";
  const record = button("Record (5 seconds)", null, { tid: "mic-record" });
  const result = el("div", { class: "mic-result" });
  const next = button("Yes, I can hear myself", null, { tid: "mic-ok", disabled: true });
  const giveUp = el("a", { href: "#", "data-tid": "mic-give-up" }, "I can't get my microphone to work");
  const retryNote = el("p", { class: "muted", hidden: true }, "Still not working? ", giveUp);
  show(el("div", { class: "screen" }, topbar("Microphone check", ctx.mic, ctx.detector),
    page("Say a test sentence",
      para("Check that the sound meter moves when you speak. Then click <b>Record</b> and read this sentence out loud:"),
      el("blockquote", { class: "say" }, sentence),
      el("div", { class: "actions" }, record), result, retryNote, el("div", { class: "actions" }, next))));

  let attempt = 0;
  record.addEventListener("click", async () => {
    if (record.disabled) return;
    attempt++;
    record.disabled = true;
    next.disabled = true;
    result.replaceChildren(el("p", {}, "Recording… Read the sentence now."));
    const from = t();
    let maxDb = -100;
    const sampler = setInterval(() => { maxDb = Math.max(maxDb, ctx.mic.lastDb ?? -100); }, 100);
    let blob;
    try {
      blob = await ctx.recorder.captureSample(5000);
    } catch (err) {
      clearInterval(sampler);
      ctx.telemetry.log("mic_playback_error", { msg: String(err?.message || err) }, { milestone: true });
      result.replaceChildren(errorBox("We could not make the playback sample. Your microphone is still recording, so please try the check again."));
      record.disabled = false;
      record.textContent = "Try recording again";
      return;
    }
    clearInterval(sampler);
    const speechMs = ctx.detector.speechMs(from, t());
    const heard = speechMs >= 700 || (ctx.detector.mode === "energy" && maxDb > -45);
    ctx.telemetry.log("mic_check", { attempt, speech_ms: speechMs, max_db: Math.round(maxDb), heard, vad: ctx.detector.mode }, { milestone: true });
    const audio = el("audio", { controls: true, src: URL.createObjectURL(blob), "data-tid": "mic-playback" });
    record.disabled = false;
    record.textContent = "Record again";
    if (heard) {
      result.replaceChildren(el("p", {}, "We heard you. Play the recording and make sure it sounds clear:"), audio);
      next.disabled = false;
    } else {
      result.replaceChildren(errorBox("We could not hear you. Check that you selected the right microphone, then try speaking a little louder."), audio);
      if (attempt >= 3) retryNote.hidden = false;
    }
  });
  const outcome = await new Promise((resolve) => {
    next.addEventListener("click", () => resolve("next"), { once: true });
    giveUp.addEventListener("click", (e) => { e.preventDefault(); resolve("give_up"); }, { once: true });
  });
  if (outcome === "give_up") {
    await ctx.screenOut("microphone not working", "screened_out");
    return "stop";
  }
  await ctx.setStep("mic", "mic_ok", { vad: ctx.detector.mode, mic: ctx.mic.info });
}

// ---------------------------------------------------------------------------
// Think-aloud instructions (after Ericsson & Simon, 1993, Appendix)
// ---------------------------------------------------------------------------

export async function instructions(ctx) {
  const next = button("Start the warm-up", null, { tid: "instructions-next" });
  show(el("div", { class: "screen" }, topbar("Instructions", ctx.mic, ctx.detector),
    page("Thinking aloud",
      para("We want to know what goes through your mind as you work, so please <b>say your thoughts out loud</b>."),
      para("Start talking as soon as each task appears and keep going until you submit your answer. Say whatever comes to mind. You don't need to organize your thoughts or explain them to us; just talk as if you were speaking to yourself."),
      para("If you go quiet, you'll see a small reminder. It disappears when you start talking again."),
      para("You'll start with three quick warm-ups."),
      el("div", { class: "actions" }, next))));
  await waitClick(next);
}

// ---------------------------------------------------------------------------
// Warm-ups
// ---------------------------------------------------------------------------

const WARMUPS = {
  multiply: { n: 1, prompt: "Multiply 24 × 36 in your head.", detail: "Think aloud while you work it out, then type your answer.", input: "number" },
  windows: { n: 2, prompt: "How many windows are there in the home you grew up in?", detail: "Think aloud as you count, then type your answer.", input: "number" },
  animals: { n: 3, prompt: "Name 20 animals.", detail: "Say them out loud. You don't need to type them. Click Done when you finish.", input: null },
};

export async function warmup(ctx, task) {
  const spec = WARMUPS[task];
  const answer = spec.input ? el("input", { type: "text", inputmode: "numeric", class: "answer", placeholder: "Your answer", "data-tid": `warmup-${task}-answer` }) : null;
  const done = button(spec.input ? "Submit answer" : "Done", null, { tid: `warmup-${task}-done` });
  if (answer) {
    done.disabled = true;
    answer.addEventListener("input", () => { done.disabled = !answer.value.trim(); });
  }
  show(el("div", { class: "screen" }, topbar(`Warm-up ${spec.n} of 3`, ctx.mic, ctx.detector),
    page(spec.prompt, el("p", { class: "lead" }, spec.detail), el("p", { class: "reminder" }, "Keep saying your thoughts out loud as you work."),
      answer, el("div", { class: "actions" }, done))));
  const started = t();
  ctx.nudger.activate(`warmup_${task}`);
  await waitClick(done);
  ctx.nudger.deactivate();
  const ended = t();
  const speechMs = ctx.detector.speechMs(started, ended);
  const data = { started_t: started, ended_t: ended, duration_ms: Math.round(ended - started), speech_ms: speechMs,
                 speech_ratio: Math.round((speechMs / Math.max(1, ended - started)) * 1000) / 1000, nudges: ctx.nudger.phaseCount };
  ctx.outbox.push({ kind: "rpc", fn: "submit_warmup", args: { p_task: task, p_answer: answer?.value?.trim() ?? null, p_data: data } });
  ctx.telemetry.log("warmup_done", { task, ...data }, { milestone: true });
  if (speechMs < 2000) {
    toast("We didn't hear much. On the next task, try to keep saying your thoughts out loud.", { ms: 7000 });
  }
}

// ---------------------------------------------------------------------------
// Decision footer, shared by the comparisons and the tools practice: pick a
// response, say how sure you are, then submit once.
// ---------------------------------------------------------------------------

function decisionBar({ tids, confName, log, ready = () => true, notReadyHint = "" }) {
  const choiceButtons = {
    left: el("button", { type: "button", class: "choice", "data-tid": tids.left }, "Response A is better"),
    right: el("button", { type: "button", class: "choice", "data-tid": tids.right }, "Response B is better"),
  };
  const conf = likert(confName, 5, { low: "Not at all sure", high: "Completely sure" });
  const submit = button("Submit", null, { tid: tids.submit, disabled: true });
  const hint = el("span", { class: "decision-hint", hidden: true, "data-tid": `${tids.submit}-hint` });
  const state = { choice: null, history: [], confHistory: [], submitted: false };

  const refresh = () => {
    const answered = Boolean(state.choice && conf.value());
    submit.disabled = state.submitted || !(answered && ready());
    hint.textContent = notReadyHint;
    hint.hidden = !(answered && !ready() && notReadyHint);
  };
  for (const [side, btn] of Object.entries(choiceButtons)) {
    btn.addEventListener("click", () => {
      state.choice = side;
      state.history.push([Math.round(t()), side]);
      choiceButtons.left.classList.toggle("selected", side === "left");
      choiceButtons.right.classList.toggle("selected", side === "right");
      log("choice", { side }, { milestone: true });
      refresh();
    });
  }
  for (const input of conf.inputs) input.addEventListener("change", () => {
    state.confHistory.push([Math.round(t()), conf.value()]);
    log("confidence", { value: conf.value() });
    refresh();
  });
  const submitted = new Promise((resolve) => {
    submit.addEventListener("click", () => {
      if (submit.disabled || state.submitted) return;
      state.submitted = true;
      submit.disabled = true;
      submit.textContent = "Submitting…";
      log("submit", {}, { milestone: true });
      resolve();
    });
  });
  const node = el("footer", { class: "decision" },
    el("div", { class: "decision-choice", role: "group", "aria-label": "Which response is better?" },
      el("span", { class: "decision-label" }, "Which response is better?"), choiceButtons.left, choiceButtons.right),
    el("div", { class: "decision-conf" }, el("span", { class: "decision-label" }, "How sure are you?"), conf.node),
    el("div", { class: "decision-submit" }, hint, submit));
  return { node, state, confidence: () => conf.value(), refresh, submitted };
}

// ---------------------------------------------------------------------------
// Tools tutorial (practice material only)
// ---------------------------------------------------------------------------

function checklist(items) {
  const state = Object.fromEntries(items.map(([id]) => [id, false]));
  const nodes = Object.fromEntries(items.map(([id, label]) => [id, el("li", { "data-tid": `todo-${id}` }, label)]));
  const node = el("ul", { class: "todo" }, ...Object.values(nodes));
  return {
    node,
    tick(id) { if (id in state && !state[id]) { state[id] = true; nodes[id].classList.add("done"); } },
    done: () => Object.values(state).every(Boolean),
  };
}

async function practicePanel(ctx, { title, condition, panes, items, match }) {
  const annot = new Annotator({ condition, ...panes, telemetry: ctx.telemetry, trialIndex: 0 });
  const todo = checklist(items);
  let unlocked = false;
  const decision = decisionBar({
    tids: { left: `tutorial-${condition}-choice-left`, right: `tutorial-${condition}-choice-right`, submit: `tutorial-${condition}-next` },
    confName: `confidence-practice-${condition}`,
    log: (type, data, opts) => ctx.telemetry.log(type, { trial: 0, practice: true, ...data }, opts),
    ready: () => unlocked || todo.done(),
    notReadyHint: "Try each tool below first.",
  });
  const original = annot.log.bind(annot);
  annot.log = (type, data) => {
    original(type, { practice: true, ...data });
    for (const id of match(type, data)) todo.tick(id);
    decision.refresh();
  };
  setTimeout(() => { unlocked = true; decision.refresh(); }, 4 * 60 * 1000); // never trap anyone in the tutorial
  show(el("div", { class: "screen trial-screen" }, topbar(title, ctx.mic, ctx.detector),
    el("div", { class: "tutorial-bar" }, el("div", { class: "tutorial-intro" }, el("b", {}, "Practice: "), "try each tool below. Then choose the better response and submit. Keep talking as you work."), todo.node),
    el("div", { class: "question" }, el("span", { class: "q-label" }, "Question"), el("div", { class: "q-text" }, brToNewline(PRACTICE.query))),
    annot.root, decision.node));
  await decision.submitted;
  return { ...annot.serialize(), choice: decision.state.choice, confidence: decision.confidence() };
}

export async function tutorial(ctx) {
  ctx.nudger.activate("tutorial");
  const textResult = await practicePanel(ctx, {
    title: "Practice 1 of 2: text answers", condition: "text", panes: PRACTICE.text,
    items: [["good", "Use Good to highlight text you like"], ["bad", "Use Bad to highlight text you do not like"],
            ["pen", "Draw something with Pen"], ["note", "Add a Note and press Enter"], ["erase", "Remove a mark with Eraser or Undo"]],
    match: (type, data) => [
      ...(type === "mark_create" && data.valence === "good" ? ["good"] : []),
      ...(type === "mark_create" && data.valence === "bad" ? ["bad"] : []),
      ...(type === "mark_create" && data.tool === "pen" ? ["pen"] : []),
      ...(type === "note_edit" && data.len > 0 ? ["note"] : []),
      ...(type === "mark_delete" || type === "undo" ? ["erase"] : []),
    ],
  });
  const imageResult = await practicePanel(ctx, {
    title: "Practice 2 of 2: image answers", condition: "image", panes: PRACTICE.image,
    items: [["zoom", "Zoom in with the mouse wheel or + button"], ["move", "Use Move to drag the image"],
            ["hl", "Use Good, Bad, or Unsure to mark part of an image"]],
    match: (type, data) => [
      ...(type === "img_view" && data.kind === "zoom" ? ["zoom"] : []),
      ...(type === "img_view" && data.kind === "pan" ? ["move"] : []),
      ...(type === "mark_create" && data.valence ? ["hl"] : []),
    ],
  });
  ctx.nudger.deactivate();
  ctx.telemetry.log("tutorial_done", { text: textResult.summary, image: imageResult.summary,
                                       choices: { text: [textResult.choice, textResult.confidence], image: [imageResult.choice, imageResult.confidence] } },
                    { milestone: true });

  const begin = button("Start study question 1", null, { tid: "start-study" });
  show(page("Thanks for warming up",
    para("The next question is the first real study question. Please keep thinking aloud as you compare the responses."),
    el("div", { class: "actions" }, begin)));
  await waitClick(begin);
}

// ---------------------------------------------------------------------------
// The two study questions
// ---------------------------------------------------------------------------

function attentionClock() {
  const state = { hiddenMs: 0, blurMs: 0, hiddenCount: 0, blurCount: 0, hiddenSince: null, blurSince: null };
  const onVis = () => {
    if (document.hidden) { state.hiddenCount++; state.hiddenSince = t(); }
    else if (state.hiddenSince !== null) { state.hiddenMs += t() - state.hiddenSince; state.hiddenSince = null; }
  };
  const onBlur = () => { state.blurCount++; state.blurSince = t(); };
  const onFocus = () => { if (state.blurSince !== null) { state.blurMs += t() - state.blurSince; state.blurSince = null; } };
  document.addEventListener("visibilitychange", onVis);
  addEventListener("blur", onBlur);
  addEventListener("focus", onFocus);
  return () => {
    onVis(); onFocus();
    document.removeEventListener("visibilitychange", onVis);
    removeEventListener("blur", onBlur);
    removeEventListener("focus", onFocus);
    return { hidden_ms: Math.round(state.hiddenMs), blur_ms: Math.round(state.blurMs), hidden_count: state.hiddenCount, blur_count: state.blurCount };
  };
}

export async function trial(ctx, spec) {
  const i = spec.trial_index;
  const annot = new Annotator({ condition: spec.condition, left: spec.left, right: spec.right, telemetry: ctx.telemetry, trialIndex: i });
  const decision = decisionBar({
    tids: { left: "choice-left", right: "choice-right", submit: "trial-submit" },
    confName: `confidence-${i}`,
    log: (type, data, opts) => ctx.telemetry.log(type, { trial: i, ...data }, opts),
  });
  const state = { firstInteraction: null };

  show(el("div", { class: "screen trial-screen" },
    topbar(el("b", {}, `Study question ${i} of 2`), ctx.mic, ctx.detector),
    el("div", { class: "question", "data-tid": "question" }, el("span", { class: "q-label" }, "Question"), el("div", { class: "q-text" }, brToNewline(spec.query))),
    annot.root,
    decision.node));

  const firstInteraction = (e) => { if (state.firstInteraction === null) state.firstInteraction = Math.round(t()); };
  addEventListener("pointerdown", firstInteraction, { capture: true, once: true });
  addEventListener("wheel", firstInteraction, { capture: true, once: true });

  const started = t();
  const stopClock = attentionClock();
  ctx.nudger.activate(`trial_${i}`);
  ctx.telemetry.log("trial_start", { trial: i, condition: spec.condition, item: spec.item_index, left: spec.left.side,
                                     variant: spec.left.variant ?? null }, { milestone: true });

  await decision.submitted;

  const ended = t();
  const { choice, history, confHistory } = decision.state;
  ctx.nudger.deactivate();
  const attention = stopClock();
  const speechMs = ctx.detector.speechMs(started, ended);
  const totalMs = Math.round(ended - started);
  const data = {
    condition: spec.condition, item_index: spec.item_index, left_side: spec.left.side,
    variants: spec.condition === "image" ? { left: spec.left.variant, right: spec.right.variant } : null,
    started_t: started, ended_t: ended, total_ms: totalMs,
    active_ms: Math.max(0, totalMs - Math.max(attention.hidden_ms, attention.blur_ms)), ...attention,
    first_interaction_t: state.firstInteraction, first_choice_t: history[0]?.[0] ?? null,
    choice_history: history, choice_changes: Math.max(0, history.length - 1), confidence_history: confHistory,
    speech_ms: speechMs, speech_ratio: Math.round((speechMs / Math.max(1, totalMs)) * 1000) / 1000, nudges: ctx.nudger.phaseCount,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    annotations: annot.serialize(),
  };
  show(page("Saving your answer…", para("This should only take a moment.")));
  await ctx.reliably("submit_trial", { p_trial_index: i, p_choice_display: choice, p_confidence: decision.confidence(), p_data: data });
  ctx.telemetry.log("trial_submitted", { trial: i, choice, confidence: decision.confidence(), total_ms: totalMs }, { milestone: true });
}

// ---------------------------------------------------------------------------
// Workload questionnaire after each comparison (NASA-TLX, raw) + 2 extra items
// ---------------------------------------------------------------------------

const TLX = [
  ["mental", "Mental demand", "How mentally demanding was the task?", "Very low", "Very high"],
  ["physical", "Physical demand", "How physically demanding was the task?", "Very low", "Very high"],
  ["temporal", "Temporal demand", "How hurried or rushed was the pace of the task?", "Very low", "Very high"],
  // Shown from Failure to Perfect (flipped from the paper form); stored in the NASA-TLX direction below.
  ["performance", "Performance", "How successful were you in accomplishing what you were asked to do?", "Failure", "Perfect"],
  ["effort", "Effort", "How hard did you have to work to accomplish your level of performance?", "Very low", "Very high"],
  ["frustration", "Frustration", "How insecure, discouraged, irritated, stressed, and annoyed were you?", "Very low", "Very high"],
];

export async function tlx(ctx, i, spec) {
  const scales = TLX.map(([id, name, question, low, high]) => ({ id, ui: scaleSlider(id, { low, high }), name, question }));
  const familiar = likert(`familiar-${i}`, 5, { low: "Not at all familiar", high: "Very familiar" });
  const easeTA = likert(`ta-ease-${i}`, 5, { low: "Very hard", high: "Very easy" });
  const next = button("Continue", null, { tid: "tlx-next", disabled: true });
  const update = () => { next.disabled = !(scales.every((s) => s.ui.value() !== null) && familiar.value() && easeTA.value()); };
  for (const s of scales) s.ui.onAnswer(update);
  for (const input of [...familiar.inputs, ...easeTA.inputs]) input.addEventListener("change", update);
  const label = spec.condition === "text" ? "text" : "image";
  show(el("div", { class: "screen" }, topbar(`${label === "text" ? "Text" : "Image"} comparison`, ctx.mic, ctx.detector),
    page("How did that comparison feel?",
      para(`Answer each question about the ${label} comparison you just completed. Click or move every slider, including when your answer is 0.`),
      ...scales.map((s) => el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, s.name), el("span", {}, s.question)), s.ui.node)),
      el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, "Familiarity"), el("span", {}, "How familiar were you with the topic of this question before the study?")), familiar.node),
      el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, "Thinking aloud"), el("span", {}, "How easy was it to think aloud during this comparison?")), easeTA.node),
      el("div", { class: "actions" }, next))));
  await waitClick(next);
  const answers = Object.fromEntries(scales.map((s) => [s.id, s.ui.value()]));
  // NASA-TLX scores performance with 0 = perfect, so store that (and the slider as shown) to keep raw_tlx standard.
  answers.performance_success = answers.performance;
  answers.performance = 100 - answers.performance_success;
  answers.raw_tlx = Math.round((TLX.reduce((sum, [id]) => sum + answers[id], 0) / TLX.length) * 10) / 10;
  answers.familiarity = familiar.value();
  answers.think_aloud_ease = easeTA.value();
  await ctx.reliably("submit_tlx", { p_trial_index: i, p_tlx: answers });
}

// ---------------------------------------------------------------------------
// Exit survey
// ---------------------------------------------------------------------------

export async function survey(ctx) {
  const pick = (name, options) => {
    const inputs = options.map(([value, label]) => el("label", { class: "check" }, el("input", { type: "radio", name, value, "data-tid": `${name}-${value}` }), " ", label));
    return { node: el("div", { class: "options" }, ...inputs), value: () => inputs.map((l) => l.querySelector("input")).find((x) => x.checked)?.value ?? null, inputs };
  };
  const easier = pick("easier", [["text", "Text"], ["images", "Images"], ["same", "No difference"]]);
  const why = el("textarea", { rows: 3, placeholder: "Tell us why", "data-tid": "survey-why" });
  const talk = likert("talk-overall", 5, { low: "Not at all", high: "The whole time" });
  const tech = pick("tech", [["no", "No"], ["yes", "Yes"]]);
  const techText = el("textarea", { rows: 2, placeholder: "What happened? (optional)", "data-tid": "survey-tech-text" });
  const comments = el("textarea", { rows: 3, placeholder: "Optional", "data-tid": "survey-comments" });
  const next = button("Finish", null, { tid: "survey-next", disabled: true });
  const update = () => { next.disabled = !(easier.value() && why.value.trim() && talk.value() && tech.value()); };
  for (const input of [...easier.inputs.map((l) => l.querySelector("input")), ...talk.inputs, ...tech.inputs.map((l) => l.querySelector("input"))]) {
    input.addEventListener("change", update);
  }
  why.addEventListener("input", update);
  show(el("div", { class: "screen" }, topbar("Final survey", ctx.mic, ctx.detector),
    page("Before you finish",
      el("div", { class: "q" }, el("p", {}, "Which format made comparing the answers easier?"), easier.node),
      el("div", { class: "q" }, el("p", {}, "Why did you choose that?"), why),
      el("div", { class: "q" }, el("p", {}, "How often were you able to say your thoughts out loud?"), talk.node),
      el("div", { class: "q" }, el("p", {}, "Did anything go wrong with the audio, images, or page?"), tech.node, techText),
      el("div", { class: "q" }, el("p", {}, "Anything else you would like us to know? (optional)"), comments),
      el("div", { class: "actions" }, next))));
  await waitClick(next);
  await ctx.reliably("submit_survey", { p_answers: {
    easier: easier.value(), why: why.value.trim(), think_aloud_amount: talk.value(),
    tech_problem: tech.value(), tech_text: techText.value.trim(), comments: comments.value.trim(),
  } });
}

// ---------------------------------------------------------------------------
// Finish: make sure every upload has landed, then return to Prolific
// ---------------------------------------------------------------------------

export async function done(ctx) {
  if (ctx.recorder?.isRecording()) await ctx.recorder.stop();
  ctx.nudger?.deactivate();
  await ctx.telemetry.flush();
  const progress = el("p", { class: "muted", "data-tid": "upload-progress" });
  show(page("Finishing up…", para("Keep this tab open while your recording finishes uploading. It should only take a few seconds."), progress));
  const started = Date.now();
  while (ctx.outbox.pending().jobs > 0 && Date.now() - started < 180000) {
    const p = ctx.outbox.pending();
    progress.textContent = `${p.jobs} item(s) left (${Math.round(p.bytes / 1024)} KB)`;
    await ctx.outbox.drain(1500);
  }
  const left = ctx.outbox.pending().jobs;
  ctx.telemetry.log("upload_drain", { left, waited_ms: Date.now() - started }, { milestone: true });
  const result = await ctx.reliably("complete_session", {});
  ctx.mic?.close();
  const url = result?.completion_url;
  show(page("Thank you!",
    para("You are done. Thank you for taking part!"),
    left ? errorBox(`${left} upload(s) are still waiting. Please keep this tab open for another minute if you can.`) : null,
    url ? el("p", {}, "Your completion code is ", el("b", { "data-tid": "completion-code" }, result.completion_code), ".") : el("p", { class: "muted" }, "No completion code is set up yet (test session)."),
    url ? el("div", { class: "actions" }, el("a", { class: "btn primary", href: url, "data-tid": "return-prolific" }, "Return to Prolific")) : null));
  if (url && !left) setTimeout(() => { location.href = url; }, 5000);
}
