// Interaction telemetry: a structured event log plus a full rrweb session replay,
// both flushed every few seconds as gzipped batches into the session's Storage
// folder through the durable outbox. Milestone events also go to the database
// (session_events) so the admin dashboard can show them without parsing batches.

import { CONFIG } from "./config.js";
import { t, wall, gzipJson, throttle, WALL_EPOCH } from "./util.js";

function describe(target) {
  if (!(target instanceof Element)) return target === document ? "document" : target === window ? "window" : null;
  const tagged = target.closest("[data-tid]");
  if (tagged) return tagged.dataset.tid;
  const id = target.id ? `#${target.id}` : "";
  const cls = typeof target.className === "string" && target.className ? `.${target.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
  return `${target.tagName.toLowerCase()}${id}${cls}`;
}

export class Telemetry {
  constructor() {
    this.events = [];
    this.rrweb = [];
    this.milestones = [];
    this.seq = { events: 0, rrweb: 0 };
    this.context = {};
    this.started = false;
  }

  // Events logged before the session exists are buffered and sent once attached.
  attach({ outbox, sessionId }) {
    this.outbox = outbox;
    this.sessionId = sessionId;
    if (!this.flushTimer) this.flushTimer = setInterval(() => this.flush(), CONFIG.telemetryFlushMs);
  }

  setContext(context) {
    this.context = { ...context };
    this.log("context", this.context, { milestone: true });
  }

  log(type, data = {}, { milestone = false } = {}) {
    const event = { t: t(), w: wall(), type, ...data };
    if (this.context.step) event.step = this.context.step;
    this.events.push(event);
    if (milestone) this.milestones.push({ type, payload: data, t: event.t, wall: event.w });
    return event;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const opts = { capture: true, passive: true };
    const pointer = throttle((e) => this.log("pointermove", { x: e.clientX, y: e.clientY, b: e.buttons, tgt: describe(e.target) }), 50);
    addEventListener("pointermove", pointer, opts);
    for (const type of ["pointerdown", "pointerup"]) {
      addEventListener(type, (e) => this.log(type, { x: e.clientX, y: e.clientY, btn: e.button, kind: e.pointerType, tgt: describe(e.target) }), opts);
    }
    addEventListener("click", (e) => this.log("click", { x: e.clientX, y: e.clientY, tgt: describe(e.target) }), opts);
    addEventListener("dblclick", (e) => this.log("dblclick", { x: e.clientX, y: e.clientY, tgt: describe(e.target) }), opts);
    addEventListener("contextmenu", (e) => this.log("contextmenu", { tgt: describe(e.target) }), opts);
    addEventListener("wheel", throttle((e) => this.log("wheel", { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), ctrl: e.ctrlKey, tgt: describe(e.target) }), 80), opts);

    const scrollers = new WeakMap();
    addEventListener("scroll", (e) => {
      const target = e.target === document ? document.scrollingElement : e.target;
      if (!(target instanceof Element)) return;
      let fn = scrollers.get(target);
      if (!fn) {
        fn = throttle(() => this.log("scroll", {
          tgt: describe(target), top: Math.round(target.scrollTop), left: Math.round(target.scrollLeft),
          sh: target.scrollHeight, ch: target.clientHeight,
        }), 100);
        scrollers.set(target, fn);
      }
      fn();
    }, opts);

    addEventListener("keydown", (e) => this.log("keydown", {
      key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, rep: e.repeat, tgt: describe(e.target),
    }), opts);
    addEventListener("input", (e) => this.log("input", { tgt: describe(e.target), len: e.target?.value?.length ?? null }), opts);
    for (const type of ["copy", "cut", "paste"]) {
      addEventListener(type, (e) => {
        const text = type === "paste" ? e.clipboardData?.getData("text") : String(getSelection() || "");
        this.log(type, { tgt: describe(e.target), len: text?.length ?? 0, text: text?.slice(0, 2000) }, { milestone: true });
      }, opts);
    }
    document.addEventListener("selectionchange", throttle(() => {
      const sel = getSelection();
      const text = String(sel || "");
      if (!text) return;
      this.log("selection", { len: text.length, text: text.slice(0, 300), tgt: describe(sel.anchorNode?.parentElement) });
    }, 300));

    document.addEventListener("visibilitychange", () => this.log("visibility", { state: document.visibilityState }, { milestone: true }));
    addEventListener("focus", () => this.log("window_focus", {}, { milestone: true }));
    addEventListener("blur", () => this.log("window_blur", {}, { milestone: true }));
    addEventListener("resize", throttle(() => this.log("resize", { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }), 300));
    const watchDpr = () => {
      matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
        this.log("zoom_change", { dpr: devicePixelRatio, w: innerWidth, h: innerHeight }, { milestone: true });
        watchDpr();
      }, { once: true });
    };
    watchDpr();
    document.addEventListener("fullscreenchange", () => this.log("fullscreen", { on: Boolean(document.fullscreenElement) }));
    addEventListener("online", () => this.log("online", {}, { milestone: true }));
    addEventListener("offline", () => this.log("offline", {}, { milestone: true }));
    addEventListener("error", (e) => this.log("js_error", {
      msg: String(e.message || e.error || "error").slice(0, 500), src: e.filename, line: e.lineno, col: e.colno,
      stack: String(e.error?.stack || "").slice(0, 1500),
    }, { milestone: true }));
    addEventListener("unhandledrejection", (e) => this.log("js_rejection", {
      msg: String(e.reason?.message || e.reason).slice(0, 500), stack: String(e.reason?.stack || "").slice(0, 1500),
    }, { milestone: true }));
    addEventListener("pagehide", () => { this.log("pagehide", {}, { milestone: true }); this.flush(); });

    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) this.log("page_timing", { dom: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ttfb: Math.round(nav.responseStart) });

    try {
      const record = window.rrwebRecord?.record || window.rrwebRecord;
      this.stopRrweb = record({
        emit: (event) => this.rrweb.push(event),
        // Do not use input: "last": that records only the change/blur event and
        // makes a whole typed answer appear at once during replay.
        sampling: { mousemove: 50, mouseInteraction: true, scroll: 100, media: 800 },
        recordCanvas: false,
        maskAllInputs: false,
        inlineStylesheet: true,
        checkoutEveryNms: 5 * 60 * 1000,
      });
    } catch (err) {
      this.log("rrweb_error", { msg: String(err?.message || err) }, { milestone: true });
    }
  }

  async flush() {
    if (!this.outbox || !this.sessionId) return;
    const tasks = [];
    for (const kind of ["events", "rrweb"]) {
      const buffer = kind === "events" ? this.events : this.rrweb;
      if (!buffer.length) continue;
      const batch = buffer.splice(0, buffer.length);
      const seq = this.seq[kind]++;
      tasks.push(this.enqueueBatch(kind, seq, batch));
    }
    if (this.milestones.length) {
      const items = this.milestones.splice(0, this.milestones.length);
      for (let i = 0; i < items.length; i += 400) {
        this.outbox.push({ kind: "rpc", fn: "log_events", args: { p_events: items.slice(i, i + 400) } });
      }
    }
    await Promise.all(tasks);
  }

  async enqueueBatch(kind, seq, batch) {
    const firstT = kind === "events" ? batch[0].t : batch[0].timestamp;
    const lastT = kind === "events" ? batch[batch.length - 1].t : batch[batch.length - 1].timestamp;
    const { blob, gzip } = await gzipJson({ session_id: this.sessionId, kind, seq, epoch_wall: WALL_EPOCH, events: batch });
    const path = `${this.sessionId}/${kind}-${String(seq).padStart(6, "0")}.json${gzip ? ".gz" : ""}`;
    await this.outbox.push({
      kind: "upload", bucket: "telemetry", path, blob, contentType: gzip ? "application/gzip" : "application/json",
      afterUpload: { fn: "register_telemetry", args: {
        p_kind: kind, p_seq: seq, p_path: path, p_n: batch.length, p_bytes: blob.size, p_first_t: firstT, p_last_t: lastT,
      } },
    });
  }
}
