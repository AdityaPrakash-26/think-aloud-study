// Shared helpers: one session clock for every timestamp, DOM building, retries.

// All client timestamps are (t, wall): t = ms on the monotonic performance clock
// since page load (comparable across audio, events, and annotations), wall =
// Date.now() for aligning with server rows. rrweb uses wall-clock timestamps.
const PERF_EPOCH = performance.now();
export const WALL_EPOCH = Date.now();
export const t = () => Math.round((performance.now() - PERF_EPOCH) * 10) / 10;
export const wall = () => Date.now();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function uuid() {
  return crypto.randomUUID();
}

// el("div", {class: "x", onclick: fn}, child, "text", ...)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "html") node.innerHTML = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export async function retry(fn, { attempts = 5, baseMs = 500, maxMs = 15000, shouldRetry = () => true } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err) || i === attempts - 1) break;
      await sleep(Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5));
    }
  }
  throw lastError;
}

export async function gzipJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === "undefined") return { blob: new Blob([bytes], { type: "application/json" }), gzip: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { blob: new Blob([await new Response(stream).arrayBuffer()], { type: "application/gzip" }), gzip: true };
}

// LFQA text carries literal <br /> tags; show them as line breaks.
export function brToNewline(text) {
  return String(text || "").replace(/<br\s*\/?>/gi, "\n");
}

export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

export function clientInfo() {
  const nav = navigator;
  return {
    ua: nav.userAgent,
    ua_data: nav.userAgentData ? { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform } : null,
    language: nav.language,
    languages: nav.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { w: screen.width, h: screen.height, avail_w: screen.availWidth, avail_h: screen.availHeight, depth: screen.colorDepth },
    window: { w: innerWidth, h: innerHeight },
    dpr: devicePixelRatio,
    cores: nav.hardwareConcurrency ?? null,
    memory_gb: nav.deviceMemory ?? null,
    pointer_fine: matchMedia("(pointer: fine)").matches,
    touch_points: nav.maxTouchPoints ?? 0,
    epoch_wall: WALL_EPOCH,
  };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
