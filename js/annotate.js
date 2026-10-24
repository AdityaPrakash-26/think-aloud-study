// Annotation layer shared by both conditions: highlighters (good / bad / unsure),
// pen, sticky notes, eraser, undo/redo. Text panes highlight exact character
// spans (selection-based); image panes take freehand highlight strokes and can be
// zoomed (wheel) and panned (drag). Every mark is timestamped on the session
// clock so it can be aligned with the think-aloud audio.

import { brToNewline, el, svgEl, t, throttle } from "./util.js";

export const TOOLS = [
  { id: "navigate", label: "Move", icon: "cursor", title: "Scroll text, or drag and zoom images" },
  { id: "hl-good", label: "Good", valence: "good", title: "Mark something good" },
  { id: "hl-bad", label: "Bad", valence: "bad", title: "Mark something bad" },
  { id: "hl-unsure", label: "Unsure", valence: "unsure", title: "Mark something you are unsure about" },
  { id: "pen", label: "Pen", icon: "pen", title: "Draw a circle, line, or arrow" },
  { id: "note", label: "Note", icon: "note", title: "Click anywhere to add a note" },
  { id: "eraser", label: "Eraser", icon: "eraser", title: "Click a mark, pen stroke, or note to remove it" },
];

const ICON_PATHS = {
  cursor: ["M5 3l13 9-6.1 1.2L9 19z", "M12 13l4 7"],
  pen: ["M4 20l4.2-1L19 8.2a2.1 2.1 0 0 0-3-3L5.2 16z", "M14.5 6.7l3 3"],
  note: ["M4 4h16v13H9l-5 3z", "M12 8v6", "M9 11h6"],
  eraser: ["M3.5 14.5 13.8 4.2a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4L10 20H6.8a2 2 0 0 1-1.4-.6l-1.9-1.9a2.1 2.1 0 0 1 0-3z", "M9.5 8.5l6 6", "M10 20h10"],
  undo: ["M9 7l-5 5 5 5", "M5 12h8a6 6 0 0 1 6 6"],
  redo: ["M15 7l5 5-5 5", "M19 12h-8a6 6 0 0 0-6 6"],
  expand: ["M8 3H3v5", "M16 3h5v5", "M8 21H3v-5", "M16 21h5v-5"],
};

function toolIcon(name) {
  const icon = svgEl("svg", { class: "tool-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" });
  icon.append(...ICON_PATHS[name].map((d) => svgEl("path", { d })));
  return icon;
}

function strokeNodes(mark) {
  const d = pathData(mark.points);
  return [
    svgEl("path", { d, class: `stroke stroke-${mark.valence || "pen"}`, "stroke-width": mark.width, "data-mark": mark.id }),
    svgEl("path", { d, class: "stroke-hit", "stroke-width": 18, "vector-effect": "non-scaling-stroke", "data-mark": mark.id }),
  ];
}

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

  replaceTextHighlight(mark, pane) {
    const overlaps = [...this.entries.values()].filter(({ mark: old }) =>
      old.kind === "text_highlight" && old.pane === mark.pane && !old.deleted_t
      && (old.start < mark.end && old.end > mark.start
          || old.valence === mark.valence && (old.end === mark.start || old.start === mark.end)));
    if (!overlaps.length) return this.create(mark, pane);

    const changes = [];
    const add = (next, visibleBefore) => {
      next.created_t = t();
      this.entries.set(next.id, { mark: next, pane });
      pane.render(next);
      changes.push({ id: next.id, before: visibleBefore, after: true });
      this.log("mark_create", summarize(next));
    };

    // Remove every overlapping mark first so the replacement and any preserved
    // left/right pieces are rendered as siblings, never nested highlights.
    for (const { mark: old, pane: oldPane } of overlaps) {
      oldPane.unrender(old);
      old.deleted_t = t();
      old.deleted_via = "highlight_replace";
      changes.push({ id: old.id, before: true, after: false });
      this.log("mark_delete", { id: old.id, via: "highlight_replace" });
    }
    const replacements = [];
    for (const { mark: old } of overlaps) {
      const preserved = [
        [old.start, Math.min(old.end, mark.start)],
        [Math.max(old.start, mark.end), old.end],
      ];
      for (const [start, end] of preserved) {
        if (end <= start) continue;
        replacements.push({ ...old, id: this.nextId("h"), start, end, text: pane.content.textContent.slice(start, end),
                            deleted_t: null, deleted_via: null });
      }
    }
    replacements.push(mark);
    replacements.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const next of replacements) {
      const previous = merged.at(-1);
      if (previous && previous.end >= next.start && previous.valence === next.valence) {
        previous.end = Math.max(previous.end, next.end);
        previous.text = pane.content.textContent.slice(previous.start, previous.end);
      } else {
        merged.push(next);
      }
    }
    for (const next of merged) add(next, false);
    pane.refreshHighlights();
    this.undoStack.push({ op: "batch", changes });
    this.redoStack = [];
  }

  remove(id, via) {
    const entry = this.entries.get(id);
    if (!entry || entry.mark.deleted_t) return;
    entry.pane.unrender(entry.mark);
    entry.mark.deleted_t = t();
    entry.mark.deleted_via = via;
    if (entry.mark.kind === "text_highlight") entry.pane.refreshHighlights();
    this.undoStack.push({ op: "delete", id });
    this.redoStack = [];
    this.log("mark_delete", { id, via });
  }

  moveNote(id, from, to) {
    if (!from || from.x === to.x && from.y === to.y) return;
    this.undoStack.push({ op: "move", id, from, to });
    this.redoStack = [];
    this.log("note_move", { id, from, to });
  }

  apply(action, direction) {
    if (action.op === "move") {
      const entry = this.entries.get(action.id);
      if (!entry || entry.mark.deleted_t) return;
      const position = direction === "undo" ? action.from : action.to;
      Object.assign(entry.mark, position);
      entry.pane.positionNote(entry.mark);
      this.log(direction, { id: action.id, op: "move", position });
      return;
    }
    if (action.op === "batch") {
      const key = direction === "undo" ? "before" : "after";
      const setVisible = ({ id, [key]: visible }) => {
        const entry = this.entries.get(id);
        if (!entry) return;
        const isVisible = !entry.mark.deleted_t;
        if (visible === isVisible) return;
        if (visible) {
          entry.mark.deleted_t = null;
          entry.pane.render(entry.mark);
        } else {
          entry.pane.unrender(entry.mark);
          entry.mark.deleted_t = t();
          entry.mark.deleted_via = direction;
        }
      };
      // Hide the current set before showing the replacement set so highlights
      // cannot briefly render inside one another.
      action.changes.filter((change) => !change[key]).forEach(setVisible);
      action.changes.filter((change) => change[key]).forEach(setVisible);
      const panes = new Set(action.changes.map(({ id }) => this.entries.get(id)).filter(Boolean)
        .filter(({ mark }) => mark.kind === "text_highlight").map(({ pane }) => pane));
      panes.forEach((pane) => pane.refreshHighlights());
      this.log(direction, { op: "batch", ids: action.changes.map((change) => change.id) });
      return;
    }
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
    if (entry.mark.kind === "text_highlight") entry.pane.refreshHighlights();
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
function makeNote(mark, { onDelete, onEdit, onToggle, canOpen, onDragStart, onDrag, onDragEnd }) {
  const area = el("textarea", { placeholder: "Write a note, then press Enter", rows: 3, "data-tid": `note-${mark.id}` });
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
  const head = el("div", { class: "note-head", title: "Drag to move this note" }, el("span", { class: "note-drag-label" }, toolIcon("note"), "Note"),
    el("button", { type: "button", class: "note-del", title: "Delete note", "aria-label": "Delete note", onclick: () => onDelete() }, "×"));
  const node = el("div", { class: "note", "data-mark": mark.id },
    head,
    area, view);
  if (mark.collapsed && mark.text) {
    view.textContent = mark.text;
    node.classList.add("collapsed");
  }
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY };
    onDragStart();
    head.setPointerCapture(e.pointerId);
    node.classList.add("dragging");
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    onDrag(dx, dy);
  });
  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    node.classList.remove("dragging");
    onDragEnd();
  };
  head.addEventListener("pointerup", finishDrag);
  head.addEventListener("pointercancel", finishDrag);
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
    // A highlight must begin and end in this response. Do not turn a drag across
    // both answers into a misleading partial highlight in whichever pane gets mouse-up.
    if (!this.content.contains(range.startContainer) || !this.content.contains(range.endContainer)) {
      sel.removeAllRanges();
      this.annotator.log("highlight_rejected", { pane: this.paneId, reason: "cross_response" });
      return;
    }
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
    store.replaceTextHighlight({ id: store.nextId("h"), pane: this.paneId, side: this.side, kind: "text_highlight",
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
      this.annotator.setTool("navigate");
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
      this.ink.append(...strokeNodes(mark));
    } else if (mark.kind === "note") {
      let from = null;
      const { node } = this.annotator.noteNode(mark, {
        onDragStart: () => { from = { x: mark.x, y: mark.y }; },
        onDrag: (dx, dy) => {
          const maxX = Math.max(0, this.surface.clientWidth - node.offsetWidth);
          const maxY = Math.max(0, this.surface.scrollHeight - node.offsetHeight);
          mark.x = Math.round(Math.max(0, Math.min(maxX, mark.x + dx)) * 10) / 10;
          mark.y = Math.round(Math.max(0, Math.min(maxY, mark.y + dy)) * 10) / 10;
          this.positionNote(mark);
        },
        onDragEnd: () => { this.annotator.store.moveNote(mark.id, from, { x: mark.x, y: mark.y }); from = null; },
      });
      this.noteNodes.set(mark.id, node);
      this.notes.append(node);
      this.positionNote(mark);
      if (!mark.text) setTimeout(() => node.querySelector("textarea")?.focus(), 0);
    }
  }

  positionNote(mark) {
    const node = this.noteNodes.get(mark.id);
    if (!node) return;
    node.style.left = `${mark.x}px`;
    node.style.top = `${mark.y}px`;
  }

  refreshHighlights() {
    for (const node of this.content.querySelectorAll("mark.hl")) node.replaceWith(...node.childNodes);
    this.content.normalize();
    const highlights = [...this.annotator.store.entries.values()]
      .map(({ mark }) => mark)
      .filter((mark) => mark.kind === "text_highlight" && mark.pane === this.paneId && !mark.deleted_t)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const highlight of highlights) this.render(highlight);
  }

  unrender(mark) {
    if (mark.kind === "note") this.noteNodes.delete(mark.id);
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
    this.label = label;
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
    const expand = el("button", { type: "button", class: "zoom-btn expand-btn", title: "Open a larger view",
                                   "aria-label": `Open ${label} in a larger view`, "data-tid": `expand-${paneId}`,
                                   onclick: () => this.openModal() }, toolIcon("expand"), el("span", {}, "Full screen"));
    this.root = el("section", { class: "pane pane-image", "data-pane": paneId },
      el("header", { class: "pane-label" }, paneName(label),
        el("span", { class: "zoom-controls" },
          zoomButton("−", "zoom-out", () => this.zoomCenter(1 / 1.25)),
          zoomButton("Fit", "fit", () => { this.fit(); this.logView("fit"); }),
          zoomButton("+", "zoom-in", () => this.zoomCenter(1.25)),
          expand)),
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
      this.status.textContent = "The image did not load. Reload the page to try again.";
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

  openModal() {
    if (this.dialog?.open) return;
    const placeholder = document.createComment(`${this.paneId}-image-pane`);
    this.root.replaceWith(placeholder);

    const close = el("button", { type: "button", class: "btn", "data-tid": `close-expanded-${this.paneId}` }, "Close");
    const toolbar = this.annotator.makeToolbar({ tid: `toolbar-expanded-${this.paneId}`, extraClass: "modal-toolbar" });
    const body = el("div", { class: "image-modal-body" }, this.root);
    const dialog = el("dialog", { class: "image-modal", "aria-label": `${this.label} larger view` },
      el("div", { class: "image-modal-shell" },
        el("header", { class: "image-modal-head" }, el("b", {}, `${this.label} — larger view`), close),
        toolbar,
        body));
    this.dialog = dialog;
    this.annotator.addToolScope(dialog);

    const restore = () => {
      placeholder.replaceWith(this.root);
      this.annotator.releaseToolbar(toolbar);
      this.annotator.removeToolScope(dialog);
      dialog.remove();
      this.dialog = null;
      this.annotator.log("image_larger_view", { pane: this.paneId, open: false });
      requestAnimationFrame(() => requestAnimationFrame(() => this.fit()));
    };
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", restore, { once: true });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    this.annotator.log("image_larger_view", { pane: this.paneId, open: true });
    requestAnimationFrame(() => requestAnimationFrame(() => this.fit()));
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
    for (const node of this.noteNodes.values()) this.positionNote(node._mark);
  }

  positionNote(mark) {
    const node = this.noteNodes.get(mark.id);
    if (!node) return;
    node.style.left = `${mark.x * this.view.s + this.view.x}px`;
    node.style.top = `${mark.y * this.view.s + this.view.y}px`;
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
      this.annotator.setTool("navigate");
    }
  }

  finishStroke(points, toolId, valence, width) {
    const store = this.annotator.store;
    store.create({ id: store.nextId("s"), pane: this.paneId, side: this.side, kind: "stroke", tool: toolId, valence,
                   width, points, bbox: bbox(points), space: "image_px", zoom: Math.round(this.view.s * 1000) / 1000 }, this);
  }

  render(mark) {
    if (mark.kind === "stroke") {
      this.ink.append(...strokeNodes(mark));
    } else if (mark.kind === "note") {
      let from = null;
      const { node } = this.annotator.noteNode(mark, {
        onDragStart: () => { from = { x: mark.x, y: mark.y }; },
        onDrag: (dx, dy) => {
          const scale = Math.max(0.001, this.view.s);
          const maxX = Math.max(0, this.W - node.offsetWidth / scale);
          const maxY = Math.max(0, this.H - node.offsetHeight / scale);
          mark.x = Math.round(Math.max(0, Math.min(maxX, mark.x + dx / scale)) * 10) / 10;
          mark.y = Math.round(Math.max(0, Math.min(maxY, mark.y + dy / scale)) * 10) / 10;
          this.positionNote(mark);
        },
        onDragEnd: () => { this.annotator.store.moveNote(mark.id, from, { x: mark.x, y: mark.y }); from = null; },
      });
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
    this.buttons = new Map(TOOLS.map((tool) => [tool.id, new Set()]));
    this.toolScopes = new Set();

    const Pane = condition === "text" ? TextPane : ImagePane;
    this.panes = {
      left: new Pane(this, { paneId: "left", label: labels[0], ...left }),
      right: new Pane(this, { paneId: "right", label: labels[1], ...right }),
    };

    const toolbar = this.makeToolbar();
    this.toolbar = toolbar;
    this.root = el("div", { class: `annotator cond-${condition}` }, toolbar,
      el("div", { class: "panes" }, this.panes.left.root, this.panes.right.root));
    this.toolScopes.add(this.root);
    this.setTool("navigate", { silent: true });
  }

  makeToolbar({ tid = "toolbar", extraClass = "" } = {}) {
    const toolbar = el("div", { class: `toolbar${extraClass ? ` ${extraClass}` : ""}`, role: "toolbar", "data-tid": tid });
    for (const tool of TOOLS) {
      const iconOnly = tool.id === "navigate";
      const button = el("button", { type: "button", class: `tool tool-${tool.id}${iconOnly ? " icon-only" : ""}`, title: tool.title,
                                    "aria-label": tool.label, "data-tid": `tool-${tool.id}`,
                                    onclick: () => this.setTool(tool.id) },
        tool.valence ? el("span", { class: `swatch swatch-${tool.valence}` }) : null,
        tool.icon ? toolIcon(tool.icon) : null,
        !iconOnly ? el("span", {}, tool.label) : null);
      button.setAttribute("aria-pressed", String(tool.id === this.tool));
      this.buttons.get(tool.id).add(button);
      toolbar.append(button);
      if (tool.id === "navigate" || tool.id === "hl-unsure" || tool.id === "note") toolbar.append(el("span", { class: "sep" }));
    }
    toolbar.append(el("span", { class: "sep" }),
      el("button", { type: "button", class: "tool icon-only", title: "Undo", "aria-label": "Undo", "data-tid": "tool-undo",
                     onclick: () => this.store.undo() }, toolIcon("undo")),
      el("button", { type: "button", class: "tool icon-only", title: "Redo", "aria-label": "Redo", "data-tid": "tool-redo",
                     onclick: () => this.store.redo() }, toolIcon("redo")));
    return toolbar;
  }

  releaseToolbar(toolbar) {
    for (const buttons of this.buttons.values()) {
      for (const button of [...buttons]) if (toolbar.contains(button)) buttons.delete(button);
    }
  }

  syncToolScope(scope) {
    for (const tool of TOOLS) scope.classList.remove(`tool-${tool.id}`);
    scope.classList.add(`tool-${this.tool}`);
  }

  addToolScope(scope) {
    this.toolScopes.add(scope);
    this.syncToolScope(scope);
  }

  removeToolScope(scope) {
    this.toolScopes.delete(scope);
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
    for (const [toolId, buttons] of this.buttons) {
      for (const button of buttons) button.setAttribute("aria-pressed", String(toolId === id));
    }
    for (const scope of this.toolScopes) this.syncToolScope(scope);
    if (!silent) this.log("tool_select", { tool: id });
  }

  noteNode(mark, drag = {}) {
    return makeNote(mark, {
      onDelete: () => this.store.remove(mark.id, "note_button"),
      onEdit: (text) => this.noteEdited(mark, text),
      onToggle: (open, via) => this.log("note_toggle", { id: mark.id, open, via }),
      canOpen: () => this.tool !== "eraser",
      onDragStart: drag.onDragStart || (() => {}),
      onDrag: drag.onDrag || (() => {}),
      onDragEnd: drag.onDragEnd || (() => {}),
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
