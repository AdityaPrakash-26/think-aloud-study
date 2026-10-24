// Small UI building blocks for the participant app.

import { el } from "./util.js";

const app = () => document.getElementById("app");

export function show(...children) {
  const root = app();
  root.replaceChildren(...children);
  root.scrollTop = 0;
  scrollTo(0, 0);
  return root;
}

export function page(title, ...body) {
  return el("main", { class: "page" }, el("h1", {}, title), ...body);
}

export function para(html) {
  return el("p", { html });
}

export function button(label, onclick, { primary = true, tid = null, disabled = false } = {}) {
  return el("button", { type: "button", class: primary ? "btn primary" : "btn", onclick, disabled, "data-tid": tid }, label);
}

export function waitClick(btn) {
  return new Promise((resolve) => btn.addEventListener("click", resolve, { once: true }));
}

// Live voice meter for the top bar: the last few seconds of mic level as a rolling row of bars,
// in the accent color while speech is detected.
export function micIndicator(mic, detector) {
  const BARS = 32;
  const canvas = el("canvas", { class: "wave", width: 192, height: 44, "aria-hidden": "true" });
  const label = el("span", { class: "speak-label" }, "Listening");
  const node = el("div", { class: "mic-ind", "data-tid": "mic-indicator" },
    el("span", { class: "rec-dot", title: "Recording" }), canvas, label);
  const levels = new Array(BARS).fill(0);
  const g = canvas.getContext("2d");
  const timer = setInterval(() => {
    if (!node.isConnected) return clearInterval(timer);
    const db = mic?.lastDb ?? -100;
    levels.push(Math.max(0, Math.min(1, (db + 65) / 50)));
    levels.shift();
    const speaking = Boolean(detector?.speaking);
    node.classList.toggle("on", speaking);
    label.textContent = speaking ? "Speaking" : "Listening";
    const css = getComputedStyle(node);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = (speaking ? css.getPropertyValue("--petrol") : css.getPropertyValue("--rule")).trim() || "#888";
    levels.forEach((v, i) => {
      const h = Math.max(4, v * 40);
      g.fillRect(i * 6, (44 - h) / 2, 4, h);
    });
  }, 100);
  return node;
}

// Where the participant is in the session, drawn as a rail of four parts in the top bar.
const STAGES = [
  ["Setup", ["landing", "consent", "mic", "instructions"]],
  ["Warm-up & practice", ["warmup_multiply", "warmup_windows", "warmup_animals", "tutorial"]],
  ["Experiment", ["trial_1", "tlx_1", "trial_2", "tlx_2"]],
  ["Final survey", ["survey", "done"]],
];
let currentStep = null;

export function setStage(step) {
  currentStep = step;
}

function progressRail() {
  const at = STAGES.findIndex(([, steps]) => steps.includes(currentStep));
  if (at < 0) return el("div");
  return el("div", { class: "rail-wrap", "data-tid": "progress" },
    el("ol", { class: "rail", "aria-label": `Part ${at + 1} of ${STAGES.length}: ${STAGES[at][0]}` },
      ...STAGES.map(([name], i) => el("li", { class: i < at ? "done" : i === at ? "now" : null, title: name, "aria-current": i === at ? "step" : null }))),
    el("span", { class: "rail-label", "aria-hidden": "true" }, `Part ${at + 1} of ${STAGES.length}`));
}

export function topbar(left, mic, detector) {
  return el("header", { class: "topbar" }, el("div", { class: "topbar-left" }, left), progressRail(), micIndicator(mic, detector));
}

let toastTimer;
export function toast(message, { ms = 6000 } = {}) {
  let node = document.getElementById("toast");
  if (!node) {
    node = el("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), ms);
}

// Silence reminder: like a toast, but it stays until hideNudge() (the participant speaks again).
export function showNudge(message) {
  let node = document.getElementById("nudge");
  if (!node) {
    node = el("div", { id: "nudge", role: "status", "aria-live": "polite" });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("show");
  document.body.classList.add("nudging");
}

export function hideNudge() {
  document.getElementById("nudge")?.classList.remove("show");
  document.body.classList.remove("nudging");
}

// Radio scale; returns {node, value()}.
export function likert(name, n, { low = "", high = "", labels = null } = {}) {
  const opts = [];
  for (let i = 1; i <= n; i++) {
    const input = el("input", { type: "radio", name, value: String(i), autocomplete: "off", "data-tid": `${name}-${i}` });
    opts.push(input);
  }
  const node = el("div", { class: "likert" },
    el("span", { class: "likert-end" }, low),
    ...opts.map((input, i) => el("label", { class: "likert-opt" }, input, el("span", {}, labels ? labels[i] : String(i + 1)))),
    el("span", { class: "likert-end" }, high));
  return { node, value: () => { const checked = opts.find((o) => o.checked); return checked ? Number(checked.value) : null; }, inputs: opts };
}

// 0-100 slider with 0 as its visible and recorded starting value.
export function scaleSlider(name, { low, high }) {
  const input = el("input", { type: "range", min: "0", max: "100", step: "5", value: "0", autocomplete: "off", "data-tid": `tlx-${name}` });
  const out = el("output", {}, "0");
  input.addEventListener("input", () => { out.textContent = input.value; });
  const node = el("div", { class: "tlx-scale" }, el("div", { class: "tlx-row" }, el("span", {}, low), input, el("span", {}, high), out));
  return { node, value: () => Number(input.value), input };
}

export function errorBox(message) {
  return el("div", { class: "error-box", role: "alert" }, message);
}
