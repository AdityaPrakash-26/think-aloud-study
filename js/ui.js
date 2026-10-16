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

// Mic level + speaking indicator for the top bar.
export function micIndicator(mic, detector) {
  const bar = el("span", { class: "level-fill" });
  const dot = el("span", { class: "speak-dot", title: "Speech detected" });
  const label = el("span", { class: "speak-label" }, "Listening");
  const node = el("div", { class: "mic-ind", "data-tid": "mic-indicator" },
    el("span", { class: "mic-icon", "aria-hidden": "true" }, "🎙"), el("span", { class: "level" }, bar), dot, label);
  const timer = setInterval(() => {
    if (!node.isConnected) return clearInterval(timer);
    const db = mic?.lastDb ?? -100;
    bar.style.width = `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
    const speaking = Boolean(detector?.speaking);
    dot.classList.toggle("on", speaking);
    label.textContent = speaking ? "Speaking" : "Listening";
  }, 100);
  return node;
}

export function topbar(left, mic, detector) {
  return el("header", { class: "topbar" }, el("div", { class: "topbar-left" }, left), micIndicator(mic, detector));
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

// Radio scale; returns {node, value()}.
export function likert(name, n, { low = "", high = "", labels = null } = {}) {
  const opts = [];
  for (let i = 1; i <= n; i++) {
    const input = el("input", { type: "radio", name, value: String(i), "data-tid": `${name}-${i}` });
    opts.push(input);
  }
  const node = el("div", { class: "likert" },
    el("span", { class: "likert-end" }, low),
    ...opts.map((input, i) => el("label", { class: "likert-opt" }, input, el("span", {}, labels ? labels[i] : String(i + 1)))),
    el("span", { class: "likert-end" }, high));
  return { node, value: () => { const checked = opts.find((o) => o.checked); return checked ? Number(checked.value) : null; }, inputs: opts };
}

// 0-100 slider that must be touched before it counts.
export function scaleSlider(name, { low, high }) {
  const input = el("input", { type: "range", min: "0", max: "100", step: "5", value: "50", class: "untouched", "data-tid": `tlx-${name}` });
  const out = el("output", {}, "–");
  let touched = false;
  const touch = () => { touched = true; input.classList.remove("untouched"); out.textContent = input.value; };
  input.addEventListener("input", touch);
  input.addEventListener("pointerdown", touch);
  const node = el("div", { class: "tlx-scale" }, el("div", { class: "tlx-row" }, el("span", {}, low), input, el("span", {}, high), out));
  return { node, value: () => (touched ? Number(input.value) : null), input };
}

export function errorBox(message) {
  return el("div", { class: "error-box", role: "alert" }, message);
}
