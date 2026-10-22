// Speech detection (Silero VAD in the browser, with an energy-based fallback)
// and the silence nudge.
//
// The nudge is deliberately gentle: it only appears after a real stretch of
// silence (default 60 s) during a think-aloud task, never blocks anything, stays
// until the participant speaks again, and uses the neutral "keep talking"
// wording from Ericsson & Simon (1993).

import { t } from "./util.js";

export class SpeechDetector {
  constructor(mic, telemetry) {
    this.mic = mic;
    this.telemetry = telemetry;
    this.mode = null;
    this.speaking = false;
    this.segments = []; // [{start, end}] in session ms
    this.lastSpeechEndT = t();
    this.currentStart = null;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn(this.speaking));
  }

  speechStart(at = t()) {
    if (this.speaking) return;
    this.speaking = true;
    this.currentStart = at;
    this.telemetry.log("speech_start", { mode: this.mode });
    this.emit();
  }

  speechEnd(at = t()) {
    if (!this.speaking) return;
    this.speaking = false;
    this.segments.push({ start: this.currentStart, end: at });
    this.lastSpeechEndT = at;
    this.telemetry.log("speech_end", { mode: this.mode, ms: Math.round(at - this.currentStart) });
    this.emit();
  }

  // Speech ms within [from, to] (session ms), counting an ongoing segment.
  speechMs(from = 0, to = t()) {
    let total = 0;
    const segments = this.speaking ? [...this.segments, { start: this.currentStart, end: t() }] : this.segments;
    for (const s of segments) total += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
    return Math.round(total);
  }

  async start() {
    try {
      await this.startSilero();
      this.mode = "silero";
    } catch (err) {
      this.telemetry.log("vad_fallback", { error: String(err?.message || err) }, { milestone: true });
      this.startEnergy();
      this.mode = "energy";
    }
    this.telemetry.log("vad_ready", { mode: this.mode }, { milestone: true });
    return this.mode;
  }

  async startSilero() {
    if (!window.vad?.MicVAD) throw new Error("vad library not loaded");
    const base = new URL("../vendor/", import.meta.url).href;
    let pendingStart = null;
    const instance = window.vad.MicVAD.new({
      model: "v5",
      audioContext: this.mic.ctx,
      getStream: async () => this.mic.stream,
      pauseStream: async () => {},
      resumeStream: async () => this.mic.stream,
      baseAssetPath: base + "vad/",
      onnxWASMBasePath: base + "ort/",
      ortConfig: (ort) => { ort.env.wasm.numThreads = 1; },
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 800,
      minSpeechMs: 250,
      preSpeechPadMs: 30,
      submitUserSpeechOnPause: false,
      startOnLoad: true,
      onSpeechStart: () => { pendingStart = t(); },
      onSpeechRealStart: () => this.speechStart(pendingStart ?? t()),
      onVADMisfire: () => { pendingStart = null; },
      onSpeechEnd: () => this.speechEnd(),
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("vad load timeout")), 20000));
    this.vad = await Promise.race([instance, timeout]);
  }

  // Fallback: adaptive noise floor; speech = 15 dB above the floor for 150 ms,
  // ends after 800 ms below it.
  startEnergy() {
    const history = [];
    let above = 0;
    let below = 0;
    this.energyTimer = setInterval(() => {
      const db = this.mic.levelDb();
      history.push(db);
      if (history.length > 200) history.shift();
      const sorted = [...history].sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -70;
      const loud = db > Math.max(floor + 15, -55);
      above = loud ? above + 50 : 0;
      below = loud ? 0 : below + 50;
      if (!this.speaking && above >= 150) this.speechStart(t() - above);
      if (this.speaking && below >= 800) this.speechEnd(t() - below);
    }, 50);
  }

  destroy() {
    clearInterval(this.energyTimer);
    this.vad?.destroy?.();
  }
}

// The reminder stays on screen until the participant speaks again (or the task ends):
// onNudge shows it, onResume hides it.
export class Nudger {
  constructor(detector, telemetry, { thresholdMs, onNudge, onResume }) {
    this.detector = detector;
    this.telemetry = telemetry;
    this.thresholdMs = thresholdMs;
    this.onNudge = onNudge;
    this.onResume = onResume;
    this.active = false;
    this.count = 0;
    this.shownAt = null;
    detector.onChange((speaking) => {
      if (!speaking) return;
      this.baseline = t();
      this.clear("speech");
    });
    this.timer = setInterval(() => this.check(), 1000);
  }

  activate(phase) {
    this.clear("phase_start");
    this.active = true;
    this.phase = phase;
    this.baseline = t();
    this.phaseCount = 0;
  }

  deactivate() {
    this.clear("phase_end");
    this.active = false;
  }

  clear(via) {
    if (this.shownAt === null) return;
    this.telemetry.log("nudge_cleared", { phase: this.phase, via, shown_ms: Math.round(t() - this.shownAt) });
    this.shownAt = null;
    this.onResume?.();
  }

  check() {
    if (!this.active || this.detector.speaking || this.shownAt !== null) return; // one reminder per silent stretch
    const silentFor = t() - Math.max(this.detector.lastSpeechEndT, this.baseline);
    if (silentFor < this.thresholdMs) return;
    this.count++;
    this.phaseCount++;
    this.baseline = t(); // the next reminder needs another full stretch of silence
    this.telemetry.log("nudge", { phase: this.phase, silent_ms: Math.round(silentFor), n: this.count }, { milestone: true });
    this.shownAt = t();
    this.onNudge?.();
  }
}
