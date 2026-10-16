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
    { id: "desktop", label: "A laptop or desktop computer (not a phone or tablet)", ok: !mobile, hard: true },
    { id: "audio", label: "A browser that can record audio (Chrome, Edge, or Firefox)", ok: Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode), hard: true },
    { id: "storage", label: "An up-to-date browser", ok: Boolean(window.indexedDB && typeof CompressionStream !== "undefined" && crypto.randomUUID), hard: true },
    { id: "width", label: `A browser window at least ${CONFIG.minWindowWidth} pixels wide (maximize the window)`, ok: innerWidth >= CONFIG.minWindowWidth, hard: false },
  ];
}

export async function landing(ctx) {
  const list = el("ul", { class: "checks" });
  const start = button("Start", null, { tid: "start" });
  const refresh = () => {
    const checks = deviceChecks();
    list.replaceChildren(...checks.map((c) => el("li", { class: c.ok ? "ok" : "bad" }, c.ok ? "✓ " : "✗ ", c.label)));
    start.disabled = !checks.every((c) => c.ok);
    return checks;
  };
  addEventListener("resize", refresh);
  const checks = refresh();
  ctx.telemetry.log("device_checks", { checks: checks.map((c) => [c.id, c.ok]) }, { milestone: true });
  show(page("Comparing answers written by AI",
    para("Thank you for taking part! In this study you will look at <b>two questions</b>, each with <b>two answers written by an AI assistant</b>, and decide which answer is better. For one question you will read the answers as <b>text</b>; for the other you will see them as <b>images</b>."),
    para("The most important part: you will <b>think aloud</b> the whole time, saying out loud everything that goes through your mind. Your voice will be recorded."),
    el("h2", {}, "You will need"),
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
  const yes = button("I agree — continue", null, { tid: "consent-yes", disabled: true });
  const no = button("I do not agree", null, { primary: false, tid: "consent-no" });
  const update = () => { yes.disabled = !(adult.checked && agree.checked); };
  adult.addEventListener("change", update);
  agree.addEventListener("change", update);
  show(page("Information and consent",
    el("div", { class: "consent" },
      el("h2", {}, "What this study is about"),
      para("We are researchers studying how people judge the quality of answers written by AI systems, and whether showing an answer as an <b>image</b> instead of <b>text</b> changes how people judge it."),
      el("h2", {}, "What you will do"),
      para("You will do three short warm-up exercises, learn a few annotation tools, compare two pairs of AI answers (one shown as text, one as images), and answer a few short questionnaires. Throughout, you will <b>think aloud</b>. It takes about " + CONFIG.estimatedMinutes + " minutes."),
      el("h2", {}, "What we record"),
      el("ul", {},
        el("li", {}, "Your voice, from the microphone check until the end of the study."),
        el("li", {}, "What you do on this study page: mouse movements, clicks, scrolling, typing, highlights, drawings, and notes, and a replay of the page as you saw it."),
        el("li", {}, "Your answers, ratings, and basic technical details of your browser.")),
      para("We do <b>not</b> record your camera, your screen outside this page, or other tabs or apps."),
      el("h2", {}, "How your data is used"),
      para("Recordings are stored securely and transcribed automatically by a cloud speech-recognition service. Only the research team can access them. Results may be published in anonymized form, which may include short quotes from what you said. Your Prolific ID is used only to manage payment and is never published."),
      el("h2", {}, "Your rights"),
      para("Taking part is voluntary. You can stop at any time by closing this window and returning the study on Prolific. There are no risks beyond normal computer use. If you have questions, message the researchers through Prolific."),
      el("label", { class: "check" }, adult, " I am 18 years of age or older."),
      el("label", { class: "check" }, agree, " I have read the information above and agree to take part, including the recording of my voice and of my activity on this page.")),
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
    para("We need to record your voice. When you click the button, your browser will ask for permission to use the microphone — please choose <b>Allow</b>."),
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
        ? "Microphone access was blocked. Click the lock or microphone icon in the address bar, allow the microphone for this site, then click the button again."
        : "We could not find a working microphone. Please connect one and click the button again."));
      allow.disabled = false;
    }
  }

  const sentence = "I am ready to think aloud while I work.";
  const record = button("Record (5 seconds)", null, { tid: "mic-record" });
  const result = el("div", { class: "mic-result" });
  const next = button("Yes, I can hear myself — continue", null, { tid: "mic-ok", disabled: true });
  const giveUp = el("a", { href: "#", "data-tid": "mic-give-up" }, "I can't get my microphone to work");
  const retryNote = el("p", { class: "muted", hidden: true }, "Still not working? ", giveUp);
  show(el("div", { class: "screen" }, topbar("Microphone check", ctx.mic, ctx.detector),
    page("Say a test sentence",
      para("Watch the level bar in the top-right corner move when you speak. Then click <b>Record</b> and read this sentence out loud:"),
      el("blockquote", { class: "say" }, sentence),
      el("div", { class: "actions" }, record), result, retryNote, el("div", { class: "actions" }, next))));

  let attempt = 0;
  record.addEventListener("click", async () => {
    if (record.disabled) return;
    attempt++;
    record.disabled = true;
    next.disabled = true;
    result.replaceChildren(el("p", {}, "Recording… please read the sentence now."));
    const from = t();
    ctx.recorder.start("mic_check", { keepLocal: true });
    let maxDb = -100;
    const sampler = setInterval(() => { maxDb = Math.max(maxDb, ctx.mic.lastDb ?? -100); }, 100);
    await sleep(5000);
    clearInterval(sampler);
    const blob = await ctx.recorder.stop();
    const speechMs = ctx.detector.speechMs(from, t());
    const heard = speechMs >= 700 || (ctx.detector.mode === "energy" && maxDb > -45);
    ctx.telemetry.log("mic_check", { attempt, speech_ms: speechMs, max_db: Math.round(maxDb), heard, vad: ctx.detector.mode }, { milestone: true });
    const audio = el("audio", { controls: true, src: URL.createObjectURL(blob), "data-tid": "mic-playback" });
    record.disabled = false;
    record.textContent = "Record again";
    if (heard) {
      result.replaceChildren(el("p", {}, "We heard you. Play it back to check it sounds clear:"), audio);
      next.disabled = false;
    } else {
      result.replaceChildren(errorBox("We could not hear any speech. Please check that the right microphone is selected and speak a little louder."), audio);
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
  const next = button("I understand — start the warm-up", null, { tid: "instructions-next" });
  show(el("div", { class: "screen" }, topbar("Instructions", ctx.mic, ctx.detector),
    page("Thinking aloud",
      para("In this study we are interested in what you <b>think about</b> while you work on the tasks. To learn this, we ask you to <b>THINK ALOUD</b> as you work."),
      para("Thinking aloud means telling us <b>everything</b> you are thinking, from the moment you first see a task until you give your answer. Please talk <b>constantly</b>. You don't need to plan what you say or explain it to us — just act as if you are alone in the room, speaking to yourself."),
      para("It is most important that you <b>keep talking</b>. If you are quiet for a while, a small reminder will appear — just carry on."),
      para("Let's practice with three short warm-up exercises."),
      el("div", { class: "actions" }, next))));
  await waitClick(next);
}

// ---------------------------------------------------------------------------
// Warm-ups
// ---------------------------------------------------------------------------

const WARMUPS = {
  multiply: { n: 1, prompt: "Multiply 24 × 36 in your head.", detail: "Think aloud while you work it out, then type your answer.", input: "number" },
  windows: { n: 2, prompt: "How many windows are there in the home you grew up in?", detail: "Think aloud as you count, then type your answer.", input: "number" },
  animals: { n: 3, prompt: "Name 20 animals.", detail: "Say them out loud. There is no need to keep count — click Done when you have finished.", input: null },
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
    page(spec.prompt, el("p", { class: "lead" }, spec.detail), el("p", { class: "reminder" }, "Remember: think aloud the whole time."),
      answer, el("div", { class: "actions" }, done))));
  const started = t();
  ctx.recorder.start(`warmup_${task}`);
  ctx.nudger.activate(`warmup_${task}`);
  await waitClick(done);
  ctx.nudger.deactivate();
  await ctx.recorder.stop();
  const ended = t();
  const speechMs = ctx.detector.speechMs(started, ended);
  const data = { started_t: started, ended_t: ended, duration_ms: Math.round(ended - started), speech_ms: speechMs,
                 speech_ratio: Math.round((speechMs / Math.max(1, ended - started)) * 1000) / 1000, nudges: ctx.nudger.phaseCount };
  ctx.outbox.push({ kind: "rpc", fn: "submit_warmup", args: { p_task: task, p_answer: answer?.value?.trim() ?? null, p_data: data } });
  ctx.telemetry.log("warmup_done", { task, ...data }, { milestone: true });
  if (speechMs < 2000) {
    toast("We didn't hear much just now — remember to say your thoughts out loud as you work.", { ms: 7000 });
  }
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
  const next = button("Continue", null, { tid: `tutorial-${condition}-next`, disabled: true });
  const original = annot.log.bind(annot);
  annot.log = (type, data) => {
    original(type, { practice: true, ...data });
    for (const id of match(type, data)) todo.tick(id);
    if (todo.done()) next.disabled = false;
  };
  setTimeout(() => { next.disabled = false; }, 4 * 60 * 1000); // never trap anyone in the tutorial
  show(el("div", { class: "screen trial-screen" }, topbar(title, ctx.mic, ctx.detector),
    el("div", { class: "tutorial-bar" }, el("div", {}, el("b", {}, "Practice: "), "try each tool. Keep thinking aloud — this is practice for that, too."), todo.node, next),
    el("div", { class: "question" }, el("span", { class: "q-label" }, "Question"), el("div", { class: "q-text" }, brToNewline(PRACTICE.query))),
    annot.root));
  await waitClick(next);
  return annot.serialize();
}

export async function tutorial(ctx) {
  ctx.recorder.start("tutorial");
  ctx.nudger.activate("tutorial");
  const textResult = await practicePanel(ctx, {
    title: "Tools practice (1 of 2): text", condition: "text", panes: PRACTICE.text,
    items: [["good", "Choose Good, then select some text you like"], ["bad", "Choose Bad, then select some text you don't like"],
            ["pen", "Draw something with the Pen"], ["note", "Add a Note and type a word"], ["erase", "Remove a mark with the Eraser (or Undo)"]],
    match: (type, data) => [
      ...(type === "mark_create" && data.valence === "good" ? ["good"] : []),
      ...(type === "mark_create" && data.valence === "bad" ? ["bad"] : []),
      ...(type === "mark_create" && data.tool === "pen" ? ["pen"] : []),
      ...(type === "note_edit" && data.len > 0 ? ["note"] : []),
      ...(type === "mark_delete" || type === "undo" ? ["erase"] : []),
    ],
  });
  const imageResult = await practicePanel(ctx, {
    title: "Tools practice (2 of 2): images", condition: "image", panes: PRACTICE.image,
    items: [["zoom", "Zoom in on an image (mouse wheel or the + button)"], ["move", "Choose Move and drag the image around"],
            ["hl", "Highlight part of an image (Good, Bad, or Unsure, then draw over it)"]],
    match: (type, data) => [
      ...(type === "img_view" && data.kind === "zoom" ? ["zoom"] : []),
      ...(type === "img_view" && data.kind === "pan" ? ["move"] : []),
      ...(type === "mark_create" && data.valence ? ["hl"] : []),
    ],
  });
  ctx.nudger.deactivate();
  await ctx.recorder.stop();
  ctx.telemetry.log("tutorial_done", { text: textResult.summary, image: imageResult.summary }, { milestone: true });
}

// ---------------------------------------------------------------------------
// The two comparisons
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
  const choiceButtons = {
    left: el("button", { type: "button", class: "choice", "data-tid": "choice-left" }, "Response A is better"),
    right: el("button", { type: "button", class: "choice", "data-tid": "choice-right" }, "Response B is better"),
  };
  const conf = likert(`confidence-${i}`, 5, { low: "Not at all sure", high: "Completely sure" });
  const submit = button("Submit my choice", null, { tid: "trial-submit", disabled: true });
  const confirmBox = el("div", { class: "confirm", hidden: true },
    el("span", {}, "Submit? You won't be able to change your answer."),
    button("Yes, submit", null, { tid: "trial-confirm" }), button("Go back", null, { primary: false, tid: "trial-cancel" }));
  const state = { choice: null, history: [], confHistory: [], firstInteraction: null };

  const update = () => { submit.disabled = !(state.choice && conf.value()); };
  for (const [side, btn] of Object.entries(choiceButtons)) {
    btn.addEventListener("click", () => {
      state.choice = side;
      state.history.push([Math.round(t()), side]);
      choiceButtons.left.classList.toggle("selected", side === "left");
      choiceButtons.right.classList.toggle("selected", side === "right");
      ctx.telemetry.log("choice", { trial: i, side }, { milestone: true });
      update();
    });
  }
  for (const input of conf.inputs) input.addEventListener("change", () => {
    state.confHistory.push([Math.round(t()), conf.value()]);
    ctx.telemetry.log("confidence", { trial: i, value: conf.value() });
    update();
  });

  const shownAs = spec.condition === "text" ? "the answers are shown as text" : "the answers are shown as images";
  show(el("div", { class: "screen trial-screen" },
    topbar(el("span", {}, el("b", {}, `Comparison ${i} of 2`), ` — ${shownAs}. Keep thinking aloud.`), ctx.mic, ctx.detector),
    el("div", { class: "question", "data-tid": "question" }, el("span", { class: "q-label" }, "Question"), el("div", { class: "q-text" }, brToNewline(spec.query))),
    annot.root,
    el("footer", { class: "decision" },
      el("div", { class: "decision-choice" }, el("span", { class: "decision-label" }, "Which response is better?"), choiceButtons.left, choiceButtons.right),
      el("div", { class: "decision-conf" }, el("span", { class: "decision-label" }, "How sure are you?"), conf.node),
      el("div", { class: "decision-submit" }, submit, confirmBox))));

  const firstInteraction = (e) => { if (state.firstInteraction === null) state.firstInteraction = Math.round(t()); };
  addEventListener("pointerdown", firstInteraction, { capture: true, once: true });
  addEventListener("wheel", firstInteraction, { capture: true, once: true });

  const started = t();
  const stopClock = attentionClock();
  ctx.recorder.start(`trial_${i}`);
  ctx.nudger.activate(`trial_${i}`);
  ctx.telemetry.log("trial_start", { trial: i, condition: spec.condition, item: spec.item_index, left: spec.left.side,
                                     variant: spec.left.variant ?? null }, { milestone: true });

  for (;;) {
    await waitClick(submit);
    submit.hidden = true;
    confirmBox.hidden = false;
    const ok = await Promise.race([waitClick(confirmBox.querySelector('[data-tid="trial-confirm"]')).then(() => true),
                                   waitClick(confirmBox.querySelector('[data-tid="trial-cancel"]')).then(() => false)]);
    if (ok) break;
    submit.hidden = false;
    confirmBox.hidden = true;
  }

  const ended = t();
  ctx.nudger.deactivate();
  const attention = stopClock();
  const speechMs = ctx.detector.speechMs(started, ended);
  const totalMs = Math.round(ended - started);
  const data = {
    condition: spec.condition, item_index: spec.item_index, left_side: spec.left.side,
    variants: spec.condition === "image" ? { left: spec.left.variant, right: spec.right.variant } : null,
    started_t: started, ended_t: ended, total_ms: totalMs,
    active_ms: Math.max(0, totalMs - Math.max(attention.hidden_ms, attention.blur_ms)), ...attention,
    first_interaction_t: state.firstInteraction, first_choice_t: state.history[0]?.[0] ?? null,
    choice_history: state.history, choice_changes: Math.max(0, state.history.length - 1), confidence_history: state.confHistory,
    speech_ms: speechMs, speech_ratio: Math.round((speechMs / Math.max(1, totalMs)) * 1000) / 1000, nudges: ctx.nudger.phaseCount,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    annotations: annot.serialize(),
  };
  show(page("Saving…", para("One moment while we save your answer.")));
  await ctx.reliably("submit_trial", { p_trial_index: i, p_choice_display: state.choice, p_confidence: conf.value(), p_data: data });
  await ctx.recorder.stop();
  ctx.telemetry.log("trial_submitted", { trial: i, choice: state.choice, confidence: conf.value(), total_ms: totalMs }, { milestone: true });
}

// ---------------------------------------------------------------------------
// Workload questionnaire after each comparison (NASA-TLX, raw) + 2 extra items
// ---------------------------------------------------------------------------

const TLX = [
  ["mental", "Mental demand", "How mentally demanding was the task?", "Very low", "Very high"],
  ["physical", "Physical demand", "How physically demanding was the task?", "Very low", "Very high"],
  ["temporal", "Temporal demand", "How hurried or rushed was the pace of the task?", "Very low", "Very high"],
  ["performance", "Performance", "How successful were you in accomplishing what you were asked to do?", "Perfect", "Failure"],
  ["effort", "Effort", "How hard did you have to work to accomplish your level of performance?", "Very low", "Very high"],
  ["frustration", "Frustration", "How insecure, discouraged, irritated, stressed, and annoyed were you?", "Very low", "Very high"],
];

export async function tlx(ctx, i, spec) {
  const scales = TLX.map(([id, name, question, low, high]) => ({ id, ui: scaleSlider(id, { low, high }), name, question }));
  const familiar = likert(`familiar-${i}`, 5, { low: "Not at all familiar", high: "Very familiar" });
  const easeTA = likert(`ta-ease-${i}`, 5, { low: "Very hard", high: "Very easy" });
  const next = button("Continue", null, { tid: "tlx-next", disabled: true });
  const update = () => { next.disabled = !(scales.every((s) => s.ui.value() !== null) && familiar.value() && easeTA.value()); };
  for (const s of scales) s.ui.input.addEventListener("input", update);
  for (const input of [...familiar.inputs, ...easeTA.inputs]) input.addEventListener("change", update);
  const label = spec.condition === "text" ? "the text comparison" : "the image comparison";
  show(el("div", { class: "screen" }, topbar(`About ${label}`, ctx.mic, ctx.detector),
    page(`About ${label} you just did`,
      para("Move every slider to the point that best matches your experience."),
      ...scales.map((s) => el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, s.name), " — ", s.question), s.ui.node)),
      el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, "Familiarity"), " — How familiar were you with the topic of this question before the study?"), familiar.node),
      el("div", { class: "tlx-item" }, el("div", { class: "tlx-q" }, el("b", {}, "Thinking aloud"), " — How easy was it to think aloud during this comparison?"), easeTA.node),
      el("div", { class: "actions" }, next))));
  await waitClick(next);
  const answers = Object.fromEntries(scales.map((s) => [s.id, s.ui.value()]));
  answers.raw_tlx = Math.round((Object.values(answers).reduce((a, b) => a + b, 0) / scales.length) * 10) / 10;
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
  const why = el("textarea", { rows: 3, placeholder: "Optional", "data-tid": "survey-why" });
  const talk = likert("talk-overall", 5, { low: "Not at all", high: "The whole time" });
  const tech = pick("tech", [["no", "No"], ["yes", "Yes"]]);
  const techText = el("textarea", { rows: 2, placeholder: "What happened? (optional)", "data-tid": "survey-tech-text" });
  const comments = el("textarea", { rows: 3, placeholder: "Optional", "data-tid": "survey-comments" });
  const next = button("Finish", null, { tid: "survey-next", disabled: true });
  const update = () => { next.disabled = !(easier.value() && talk.value() && tech.value()); };
  for (const input of [...easier.inputs.map((l) => l.querySelector("input")), ...talk.inputs, ...tech.inputs.map((l) => l.querySelector("input"))]) {
    input.addEventListener("change", update);
  }
  show(el("div", { class: "screen" }, topbar("Last questions", ctx.mic, ctx.detector),
    page("A few last questions",
      el("div", { class: "q" }, el("p", {}, "Which format made it easier to judge which answer was better?"), easier.node),
      el("div", { class: "q" }, el("p", {}, "Why? (optional)"), why),
      el("div", { class: "q" }, el("p", {}, "How much of the time were you able to think aloud?"), talk.node),
      el("div", { class: "q" }, el("p", {}, "Did you have any technical problems (audio, images, the page)?"), tech.node, techText),
      el("div", { class: "q" }, el("p", {}, "Any other comments? (optional)"), comments),
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
  show(page("Saving your recording…", para("Please keep this tab open while we finish uploading. This usually takes a few seconds."), progress));
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
    para("You have finished the study. Thank you for thinking aloud with us!"),
    left ? errorBox(`${left} upload(s) are still pending. If you can, keep this tab open for another minute before closing it.`) : null,
    url ? el("p", {}, "Your completion code is ", el("b", { "data-tid": "completion-code" }, result.completion_code), ".") : el("p", { class: "muted" }, "(No completion code is configured — test session.)"),
    url ? el("div", { class: "actions" }, el("a", { class: "btn primary", href: url, "data-tid": "return-prolific" }, "Return to Prolific")) : null));
  if (url && !left) setTimeout(() => { location.href = url; }, 5000);
}
