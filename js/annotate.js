// Annotation layer shared by both conditions: highlighters (good / bad / unsure),
// pen, sticky notes, eraser, undo/redo. Text panes highlight exact character
// spans (selection-based); image panes take freehand highlight strokes and can be
// zoomed (wheel) and panned (drag). Every mark is timestamped on the session
// clock so it can be aligned with the think-aloud audio.

import { brToNewline, el, svgEl, t, throttle } from "./util.js";

export const TOOLS = [
  { id: "navigate", label: "Move", title: "Scroll the text, or drag and zoom the images" },
  { id: "hl-good", label: "Good", valence: "good", title: "Highlight something good" },
  { id: "hl-bad", label: "Bad", valence: "bad", title: "Highlight something bad" },
  { id: "hl-unsure", label: "Unsure", valence: "unsure", title: "Highlight something you are unsure about" },
  { id: "pen", label: "Pen", title: "Draw: circle, underline, point" },
  { id: "note", label: "Note", title: "Click anywhere to add a note" },
  { id: "eraser", label: "Eraser", title: "Click a mark or note to remove it" },
];

// "Response A" with its letter in a badge; both panes are drawn the same way.
function paneName(label) {
  return el("span", { class: "pane-name" }, el("span", { class: "pane-letter", "aria-hidden": "true" }, label.slice(-1)), label);
}

const STROKE_COLORS = { good: "#16a34a", bad: "#dc2626", unsure: "#ca8a04", pen: "#2563eb" };

// ---------------------------------------------------------------------------
// Marks + undo/redo
// ---------------------------------------------------------------------------

class MarkStore {
  constructor(log) {
    this.log = log;
    this.entries = new Map(); // id -> {mark, pane}
    this.undoStack = [];
    this.redoStack = [];
    this.counter = 0;
    this.stats = { undo: 0, redo: 0 };
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  create(mark, pane) {
    mark.created_t = t();
    this.entries.set(mark.id, { mark, pane });
    pane.render(mark);
    this.undoStack.push({ op: "create", id: mark.id });
    this.redoStack = [];
    this.log("mark_create", summarize(mark));
  }

  remove(id, via) {
    const entry = this.entries.get(id);
    if (!entry || entry.mark.deleted_t) return;
    entry.pane.unrender(entry.mark);
    entry.mark.deleted_t = t();
    entry.mark.deleted_via = via;
    this.undoStack.push({ op: "delete", id });
    this.redoStack = [];
    this.log("mark_delete", { id, via });
  }

  apply(action, direction) {
    const entry = this.entries.get(action.id);
    if (!entry) return;
    const makeVisible = (action.op === "create") === (direction === "redo");
    if (makeVisible) {
      entry.mark.deleted_t = null;
      entry.pane.render(entry.mark);
    } else {
      entry.pane.unrender(entry.mark);
      entry.mark.deleted_t = t();
      entry.mark.deleted_via = direction;
    }
    this.log(direction, { id: action.id, op: action.op, visible: makeVisible });
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) return;
    this.stats.undo++;
    this.apply(action, "undo");
    this.redoStack.push(action);
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return;
    this.stats.redo++;
    this.apply(action, "redo");
    this.undoStack.push(action);
  }

  all() {
    return [...this.entries.values()].map(({ mark }) => ({ ...mark }));
  }
}

function summarize(mark) {
  const out = { id: mark.id, pane: mark.pane, side: mark.side, kind: mark.kind, tool: mark.tool, valence: mark.valence ?? null };
  if (mark.kind === "text_highlight") Object.assign(out, { start: mark.start, end: mark.end, text: mark.text.slice(0, 500) });
  if (mark.kind === "stroke") Object.assign(out, { n: mark.points.length, bbox: mark.bbox });
  if (mark.kind === "note") Object.assign(out, { x: mark.x, y: mark.y });
  return out;
}

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
}

function pathData(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
}

// Freehand stroke capture on `surface`; toLocal maps a PointerEvent to local coords.
function captureStrokes(surface, { isActive, toLocal, begin, minStep = 1.5 }) {
  let current = null;
  surface.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !isActive()) return;
    const style = begin();
    if (!style) return;
    e.preventDefault();
    surface.setPointerCapture(e.pointerId);
    const [x, y] = toLocal(e);
    current = { ...style, points: [[x, y, Math.round(t())]] };
    current.path = svgEl("path", { d: pathData(current.points), class: `stroke stroke-${style.className}`, "stroke-width": style.width });
    style.svg.append(current.path);
  });
  surface.addEventListener("pointermove", (e) => {
    if (!current) return;
    const [x, y] = toLocal(e);
    const last = current.points[current.points.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < minStep / (current.scale || 1)) return;
    current.points.push([x, y, Math.round(t())]);
    current.path.setAttribute("d", pathData(current.points));
  });
  const end = () => {
    if (!current) return;
    const done = current;
    current = null;
    done.path.remove();
    if (done.points.length >= 2) done.finish(done.points);
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
}

// A sticky note. Enter (or clicking away) saves it and collapses it to its text;
// clicking the collapsed note opens it again. Shift+Enter starts a new line.
function makeNote(mark, { onDelete, onEdit, onToggle, canOpen }) {
  const area = el("textarea", { placeholder: "Type your note, then press Enter", rows: 3, "data-tid": `note-${mark.id}` });
  area.value = mark.text || "";
  const view = el("div", { class: "note-text", "data-tid": `note-text-${mark.id}`, title: "Click to edit" });
  let timer;
  const save = () => { clearTimeout(timer); onEdit(area.value); };
  const setOpen = (open, via) => {
    if (open === !mark.collapsed) return;
    mark.collapsed = !open;
    view.textContent = area.value;
    node.classList.toggle("collapsed", !open);
    onToggle(open, via);
    if (open) setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 0);
  };
  area.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => onEdit(area.value), 600);
  });
  area.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    save();
    if (area.value.trim()) { setOpen(false, "enter"); area.blur(); }
  });
  area.addEventListener("blur", () => {
    save();
    if (area.value.trim()) setOpen(false, "blur");
  });
  view.addEventListener("click", () => { if (canOpen()) setOpen(true, "click"); });
  const node = el("div", { class: "note", "data-mark": mark.id },
    el("div", { class: "note-head" }, el("span", {}, "Note"),
      el("button", { type: "button", class: "note-del", title: "Delete note", onclick: () => onDelete() }, "×")),
    area, view);
  if (mark.collapsed && mark.text) {
    view.textContent = mark.text;
    node.classList.add("collapsed");
  }
  node.addEventListener("pointerdown", (e) => e.stopPropagation());
  return { node, area };
}

// ---------------------------------------------------------------------------
// Text pane
// ---------------------------------------------------------------------------

export function renderMarkdown(text) {
  const html = window.marked.parse(brToNewline(text), { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "iframe", "script", "style", "form", "input"], FORBID_ATTR: ["style"] });
}

class TextPane {
  constructor(annotator, { paneId, label, side, text }) {
    this.annotator = annotator;
    this.paneId = paneId;
    this.side = side;
    this.content = el("div", { class: "content md", "data-tid": `content-${paneId}` });
    this.content.innerHTML = renderMarkdown(text);
    this.ink = svgEl("svg", { class: "ink" });
    this.notes = el("div", { class: "notes" });
    this.surface = el("div", { class: "surface" }, this.content, this.ink, this.notes);
    this.scroller = el("div", { class: "scroller", "data-tid": `scroller-${paneId}` }, this.surface);
    this.root = el("section", { class: "pane pane-text", "data-pane": paneId },
      el("header", { class: "pane-label" }, paneName(label)), this.scroller);
    this.noteNodes = new Map();
    this.scrollStats = { events: 0, maxFrac: 0 };

    // The surface fills the pane even below a short answer, so the pen and notes work anywhere in it.
    const sizeInk = new ResizeObserver(() => {
      this.ink.setAttribute("width", this.surface.scrollWidth);
      this.ink.setAttribute("height", this.surface.scrollHeight);
    });
    sizeInk.observe(this.content);
    sizeInk.observe(this.surface);

    this.scroller.addEventListener("scroll", throttle(() => {
      const frac = (this.scroller.scrollTop + this.scroller.clientHeight) / Math.max(1, this.scroller.scrollHeight);
      this.scrollStats.events++;
      this.scrollStats.maxFrac = Math.max(this.scrollStats.maxFrac, Math.min(1, frac));
    }, 100), { passive: true });

    this.content.addEventListener("pointerup", () => setTimeout(() => this.maybeHighlight(), 0));
    this.surface.addEventListener("click", (e) => this.onClick(e));
    captureStrokes(this.ink, {
      isActive: () => this.annotator.tool === "pen",
      toLocal: (e) => this.local(e),
      begin: () => ({ svg: this.ink, width: 2.5, className: "pen", finish: (points) => this.finishStroke(points, "pen", null, 2.5) }),
    });
    this.measureVisibility();
  }

  local(e) {
    const rect = this.surface.getBoundingClientRect();
    return [Math.round((e.clientX - rect.left) * 10) / 10, Math.round((e.clientY - rect.top) * 10) / 10];
  }

  textNodes() {
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  offsetOf(node, offset) {
    let total = 0;
    for (const textNode of this.textNodes()) {
      if (textNode === node) return total + offset;
      total += textNode.length;
    }
    return null;
  }

  maybeHighlight() {
    const tool = TOOLS.find((x) => x.id === this.annotator.tool);
    if (!tool?.valence) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    // Clip to this response's text: triple-clicks and drags often overshoot it.
    const bounds = document.createRange();
    bounds.selectNodeContents(this.content);
    if (!range.intersectsNode(this.content)) return;
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(bounds.startContainer, bounds.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(bounds.endContainer, bounds.endOffset);
    const boundary = (container, offset) => {
      if (container.nodeType === Node.TEXT_NODE) return this.offsetOf(container, offset);
      // Element boundary: offset counts child nodes; measure text before that child.
      const probe = document.createRange();
      probe.setStart(this.content, 0);
      probe.setEnd(container, offset);
      return probe.toString().length;
    };
    const start = boundary(range.startContainer, range.startOffset);
    const end = boundary(range.endContainer, range.endOffset);
    sel.removeAllRanges();
    if (start === null || end === null || end - start < 1) return;
    const text = this.content.textContent.slice(start, end);
    if (!text.trim()) return;
    const store = this.annotator.store;
    store.create({ id: store.nextId("h"), pane: this.paneId, side: this.side, kind: "text_highlight",
                   tool: tool.id, valence: tool.valence, start, end, text }, this);
  }

  rangeFromOffsets(start, end) {
    const range = document.createRange();
    let total = 0;
    let started = false;
    for (const node of this.textNodes()) {
      const next = total + node.length;
      if (!started && start <= next) { range.setStart(node, start - total); started = true; }
      if (started && end <= next) { range.setEnd(node, end - total); return range; }
      total = next;
    }
    return null;
  }

  onClick(e) {
    const tool = this.annotator.tool;
    if (tool === "eraser") {
      const target = e.target.closest("[data-mark]");
      if (target && this.root.contains(target)) this.annotator.store.remove(target.dataset.mark, "eraser");
      return;
    }
    if (tool === "note" && !e.target.closest(".note")) {
      const [x, y] = this.local(e);
      const store = this.annotator.store;
      store.create({ id: store.nextId("n"), pane: this.paneId, side: this.side, kind: "note", tool: "note", x, y, text: "", edits: [] }, this);
    }
  }

  finishStroke(points, toolId, valence, width) {
    const store = this.annotator.store;
    store.create({ id: store.nextId("s"), pane: this.paneId, side: this.side, kind: "stroke", tool: toolId, valence,
                   width, points, bbox: bbox(points), space: "text_px" }, this);
  }

  render(mark) {
    if (mark.kind === "text_highlight") {
      const range = this.rangeFromOffsets(mark.start, mark.end);
      if (!range) return;
      const pieces = [];
      for (const node of this.textNodes()) {
        if (!range.intersectsNode(node)) continue;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        if (to > from) pieces.push({ node, from, to });
      }
      for (const { node, from, to } of pieces) {
        let target = node;
        if (to < target.length) target.splitText(to);
        if (from > 0) target = target.splitText(from);
        const wrap = el("mark", { class: `hl hl-${mark.valence}`, "data-mark": mark.id });
        target.parentNode.insertBefore(wrap, target);
        wrap.append(target);
      }
    } else if (mark.kind === "stroke") {
      this.ink.append(svgEl("path", { d: pathData(mark.points), class: `stroke stroke-${mark.valence || "pen"}`,
                                      "stroke-width": mark.width, "data-mark": mark.id }));
    } else if (mark.kind === "note") {
      const { node } = this.annotator.noteNode(mark);
      node.style.left = `${mark.x}px`;
      node.style.top = `${mark.y}px`;
      this.notes.append(node);
      if (!mark.text) setTimeout(() => node.querySelector("textarea")?.focus(), 0);
    }
  }

  unrender(mark) {
    for (const node of this.root.querySelectorAll(`[data-mark="${mark.id}"]`)) {
      if (node.tagName === "MARK") node.replaceWith(...node.childNodes);
      else node.remove();
    }
    this.content.normalize();
  }

  measureVisibility() {
    // Fraction of the response ever scrolled into view.
    this.viewStats = () => ({ scroll_events: this.scrollStats.events, max_seen_frac: Math.round(this.scrollStats.maxFrac * 1000) / 1000,
                              height: this.scroller.scrollHeight, viewport: this.scroller.clientHeight });
  }

  stats() {
    if (this.scrollStats.maxFrac === 0) {
      this.scrollStats.maxFrac = Math.min(1, this.scroller.clientHeight / Math.max(1, this.scroller.scrollHeight));
    }
    return this.viewStats();
  }
}

// ---------------------------------------------------------------------------
// Image pane
// ---------------------------------------------------------------------------

class ImagePane {
  constructor(annotator, { paneId, label, side, image, width, height }) {
    this.annotator = annotator;
    this.paneId = paneId;
    this.side = side;
    this.src = image;
    this.W = width || 1536;
    this.H = height || 864;
    this.view = { s: 1, x: 0, y: 0 };
    this.zoomStats = { events: 0, max: 0, fit: 1 };

    this.img = el("img", { alt: `Response ${label.slice(-1)}`, draggable: "false", "data-tid": `img-${paneId}` });
    this.ink = svgEl("svg", { class: "ink", viewBox: `0 0 ${this.W} ${this.H}`, width: this.W, height: this.H });
    this.stage = el("div", { class: "stage" }, this.img, this.ink);
    this.notes = el("div", { class: "notes" });
    this.status = el("div", { class: "img-status" }, "Loading image…");
    this.viewport = el("div", { class: "viewport", "data-tid": `viewport-${paneId}` }, this.stage, this.notes, this.status);
    const zoomButton = (text, title, fn) => el("button", { type: "button", class: "zoom-btn", title, onclick: fn, "data-tid": `zoom-${title}-${paneId}` }, text);
    this.root = el("section", { class: "pane pane-image", "data-pane": paneId },
      el("header", { class: "pane-label" }, paneName(label),
        el("span", { class: "zoom-controls" },
          zoomButton("−", "zoom-out", () => this.zoomCenter(1 / 1.25)),
          zoomButton("Fit", "fit", () => { this.fit(); this.logView("fit"); }),
          zoomButton("+", "zoom-in", () => this.zoomCenter(1.25)))),
      this.viewport);
    this.noteNodes = new Map();

    this.stage.style.width = `${this.W}px`;
    this.stage.style.height = `${this.H}px`;
    const loadStart = performance.now();
    this.img.addEventListener("load", () => {
      this.status.remove();
      this.loadMs = Math.round(performance.now() - loadStart);
      annotator.log("img_loaded", { pane: paneId, ms: this.loadMs, nw: this.img.naturalWidth, nh: this.img.naturalHeight });
      this.fit();
    });
    this.img.addEventListener("error", () => {
      this.status.textContent = "This image did not load. Please reload the page.";
      annotator.log("img_error", { pane: paneId, src: this.src });
    });
    this.img.src = image;

    new ResizeObserver(() => this.fit(true)).observe(this.viewport);
    this.viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    // Pan with the Move tool.
    let drag = null;
    this.viewport.addEventListener("pointerdown", (e) => {
      if (this.annotator.tool !== "navigate" || e.button !== 0 || e.target.closest(".note")) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.viewport.setPointerCapture(e.pointerId);
      this.viewport.classList.add("dragging");
    });
    this.viewport.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.view.x = drag.vx + (e.clientX - drag.x);
      this.view.y = drag.vy + (e.clientY - drag.y);
      this.apply();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      this.viewport.classList.remove("dragging");
      this.logView("pan");
    };
    this.viewport.addEventListener("pointerup", endDrag);
    this.viewport.addEventListener("pointercancel", endDrag);
    this.viewport.addEventListener("click", (e) => this.onClick(e));

    captureStrokes(this.viewport, {
      isActive: () => ["pen", "hl-good", "hl-bad", "hl-unsure"].includes(this.annotator.tool),
      toLocal: (e) => this.toImage(e),
      begin: () => {
        const tool = TOOLS.find((x) => x.id === this.annotator.tool);
        const isPen = tool.id === "pen";
        const width = Math.round(((isPen ? 3 : 18) / this.view.s) * 10) / 10;
        return { svg: this.ink, width, scale: this.view.s, className: isPen ? "pen" : tool.valence,
                 finish: (points) => this.finishStroke(points, tool.id, tool.valence ?? null, width) };
      },
    });
  }

  toImage(e) {
    const rect = this.viewport.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.view.x) / this.view.s;
    const y = (e.clientY - rect.top - this.view.y) / this.view.s;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  fitScale() {
    const vw = this.viewport.clientWidth || 1;
    const vh = this.viewport.clientHeight || 1;
    return Math.min(vw / this.W, vh / this.H);
  }

  fit(onResize = false) {
    if (onResize && this.zoomStats.events > 0) return this.apply(); // keep the participant's zoom
    const s = this.fitScale();
    this.zoomStats.fit = s;
    this.view = { s, x: (this.viewport.clientWidth - this.W * s) / 2, y: (this.viewport.clientHeight - this.H * s) / 2 };
    this.apply();
  }

  zoomAt(clientX, clientY, factor) {
    const rect = this.viewport.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const fit = this.fitScale();
    const s = Math.min(fit * 8, Math.max(fit * 0.5, this.view.s * factor));
    const ix = (px - this.view.x) / this.view.s;
    const iy = (py - this.view.y) / this.view.s;
    this.view = { s, x: px - ix * s, y: py - iy * s };
    this.apply();
    this.zoomStats.events++;
    this.zoomStats.max = Math.max(this.zoomStats.max, s / fit);
    this.logViewThrottled();
  }

  zoomCenter(factor) {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  logView(kind) {
    this.annotator.log("img_view", { pane: this.paneId, kind, s: Math.round(this.view.s * 1000) / 1000,
                                     rel: Math.round((this.view.s / this.fitScale()) * 100) / 100,
                                     x: Math.round(this.view.x), y: Math.round(this.view.y) });
  }

  logViewThrottled = throttle(() => this.logView("zoom"), 250);

  apply() {
    this.stage.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.s})`;
    for (const [id, node] of this.noteNodes) {
      const mark = node._mark;
      node.style.left = `${mark.x * this.view.s + this.view.x}px`;
      node.style.top = `${mark.y * this.view.s + this.view.y}px`;
    }
  }

  onClick(e) {
    const tool = this.annotator.tool;
    if (tool === "eraser") {
      const target = e.target.closest("[data-mark]");
      if (target && this.root.contains(target)) this.annotator.store.remove(target.dataset.mark, "eraser");
      return;
    }
    if (tool === "note" && !e.target.closest(".note") && !e.target.closest(".zoom-controls")) {
      const [x, y] = this.toImage(e);
      const store = this.annotator.store;
      store.create({ id: store.nextId("n"), pane: this.paneId, side: this.side, kind: "note", tool: "note", x, y, text: "", edits: [], space: "image_px" }, this);
    }
  }

  finishStroke(points, toolId, valence, width) {
    const store = this.annotator.store;
    store.create({ id: store.nextId("s"), pane: this.paneId, side: this.side, kind: "stroke", tool: toolId, valence,
                   width, points, bbox: bbox(points), space: "image_px", zoom: Math.round(this.view.s * 1000) / 1000 }, this);
  }

  render(mark) {
    if (mark.kind === "stroke") {
      this.ink.append(svgEl("path", { d: pathData(mark.points), class: `stroke stroke-${mark.valence || "pen"}`,
                                      "stroke-width": mark.width, "data-mark": mark.id }));
    } else if (mark.kind === "note") {
      const { node } = this.annotator.noteNode(mark);
      node._mark = mark;
      this.noteNodes.set(mark.id, node);
      this.notes.append(node);
      this.apply();
      if (!mark.text) setTimeout(() => node.querySelector("textarea")?.focus(), 0);
    }
  }

  unrender(mark) {
    this.noteNodes.delete(mark.id);
    for (const node of this.root.querySelectorAll(`[data-mark="${mark.id}"]`)) node.remove();
  }

  stats() {
    return { zoom_events: this.zoomStats.events, max_zoom_rel: Math.round(this.zoomStats.max * 100) / 100,
             final_zoom_rel: Math.round((this.view.s / this.fitScale()) * 100) / 100, load_ms: this.loadMs ?? null };
  }
}

// ---------------------------------------------------------------------------
// Annotator: toolbar + two panes + store
// ---------------------------------------------------------------------------

export class Annotator {
  constructor({ condition, left, right, telemetry, trialIndex, labels = ["Response A", "Response B"] }) {
    this.condition = condition;
    this.telemetry = telemetry;
    this.trialIndex = trialIndex;
    this.store = new MarkStore((type, data) => this.log(type, data));
    this.tool = "navigate";
    this.toolSince = t();
    this.toolTime = {};
    this.toolSelections = {};
    this.noteEdits = 0;

    const Pane = condition === "text" ? TextPane : ImagePane;
    this.panes = {
      left: new Pane(this, { paneId: "left", label: labels[0], ...left }),
      right: new Pane(this, { paneId: "right", label: labels[1], ...right }),
    };

    this.buttons = new Map();
    const toolbar = el("div", { class: "toolbar", role: "toolbar", "data-tid": "toolbar" });
    for (const tool of TOOLS) {
      const button = el("button", { type: "button", class: `tool tool-${tool.id}`, title: tool.title, "data-tid": `tool-${tool.id}`,
                                    onclick: () => this.setTool(tool.id) },
        tool.valence ? el("span", { class: `swatch swatch-${tool.valence}` }) : null,
        el("span", {}, tool.label));
      this.buttons.set(tool.id, button);
      toolbar.append(button);
      if (tool.id === "navigate" || tool.id === "hl-unsure" || tool.id === "note") toolbar.append(el("span", { class: "sep" }));
    }
    toolbar.append(el("span", { class: "sep" }),
      el("button", { type: "button", class: "tool", title: "Undo", "data-tid": "tool-undo", onclick: () => this.store.undo() }, el("span", {}, "Undo")),
      el("button", { type: "button", class: "tool", title: "Redo", "data-tid": "tool-redo", onclick: () => this.store.redo() }, el("span", {}, "Redo")));
    this.toolbar = toolbar;
    this.root = el("div", { class: `annotator cond-${condition}` }, toolbar,
      el("div", { class: "panes" }, this.panes.left.root, this.panes.right.root));
    this.setTool("navigate", { silent: true });
  }

  log(type, data = {}) {
    this.telemetry.log(type, { trial: this.trialIndex, ...data });
  }

  setTool(id, { silent = false } = {}) {
    const now = t();
    this.toolTime[this.tool] = (this.toolTime[this.tool] || 0) + (now - this.toolSince);
    this.tool = id;
    this.toolSince = now;
    this.toolSelections[id] = (this.toolSelections[id] || 0) + 1;
    for (const [toolId, button] of this.buttons) button.setAttribute("aria-pressed", String(toolId === id));
    this.root.className = `annotator cond-${this.condition} tool-${id}`;
    if (!silent) this.log("tool_select", { tool: id });
  }

  noteNode(mark) {
    return makeNote(mark, {
      onDelete: () => this.store.remove(mark.id, "note_button"),
      onEdit: (text) => this.noteEdited(mark, text),
      onToggle: (open, via) => this.log("note_toggle", { id: mark.id, open, via }),
      canOpen: () => this.tool !== "eraser",
    });
  }

  noteEdited(mark, text) {
    if (mark.text === text) return;
    mark.text = text;
    mark.edits.push([Math.round(t()), text.length]);
    this.noteEdits++;
    this.log("note_edit", { id: mark.id, len: text.length, text: text.slice(0, 2000) });
  }

  serialize() {
    this.setTool(this.tool, { silent: true }); // closes the current tool interval
    const marks = this.store.all();
    const live = marks.filter((m) => !m.deleted_t);
    const count = (pred) => live.filter(pred).length;
    return {
      marks,
      summary: {
        live: live.length,
        created: marks.length,
        deleted: marks.length - live.length,
        good: count((m) => m.valence === "good"),
        bad: count((m) => m.valence === "bad"),
        unsure: count((m) => m.valence === "unsure"),
        pen: count((m) => m.tool === "pen"),
        notes: count((m) => m.kind === "note"),
        note_chars: live.filter((m) => m.kind === "note").reduce((s, m) => s + (m.text || "").length, 0),
        by_side: { left: count((m) => m.pane === "left"), right: count((m) => m.pane === "right") },
        undo: this.store.stats.undo,
        redo: this.store.stats.redo,
        note_edits: this.noteEdits,
      },
      tool_time_ms: Object.fromEntries(Object.entries(this.toolTime).map(([k, v]) => [k, Math.round(v)])),
      tool_selections: this.toolSelections,
      panes: { left: this.panes.left.stats(), right: this.panes.right.stats() },
    };
  }
}
