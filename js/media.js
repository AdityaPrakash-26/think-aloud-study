// Microphone, level meter, and segment recorder.
//
// Audio is captured as close to raw as the browser allows (no noise suppression,
// no echo cancellation; auto gain on so quiet speakers stay audible). Each task
// is its own "segment"; segments roll over into ~5-minute "parts" (separate,
// independently decodable files) with a short overlap so no words are lost.
// Every MediaRecorder chunk goes straight into the durable outbox.

import { CONFIG } from "./config.js";
import { t, wall, uuid, sleep } from "./util.js";

export class Mic {
  constructor(telemetry) {
    this.telemetry = telemetry;
    this.levels = []; // per-second {t, mean_db, max_db}
    this.listeners = new Set();
  }

  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    this.track = this.stream.getAudioTracks()[0];
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);

    this.track.addEventListener("ended", () => {
      this.telemetry.log("mic_track_ended", {}, { milestone: true });
      this.listeners.forEach((fn) => fn({ type: "ended" }));
    });
    this.track.addEventListener("mute", () => this.telemetry.log("mic_track_muted", {}, { milestone: true }));
    this.track.addEventListener("unmute", () => this.telemetry.log("mic_track_unmuted", {}));

    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    this.info = {
      label: this.track.label,
      settings: this.track.getSettings(),
      sample_rate: this.ctx.sampleRate,
      inputs: devices.filter((d) => d.kind === "audioinput").length,
    };
    this.telemetry.log("mic_open", this.info, { milestone: true });
    this.startSampler();
    return this.info;
  }

  levelDb() {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }

  startSampler() {
    let window = [];
    this.sampler = setInterval(() => {
      const db = this.levelDb();
      this.lastDb = db;
      window.push(db);
      if (window.length >= 10) {
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const entry = { t: t(), mean_db: Math.round(mean * 10) / 10, max_db: Math.round(Math.max(...window) * 10) / 10 };
        this.levels.push(entry);
        this.telemetry.log("mic_level", entry);
        window = [];
      }
    }, 100);
  }

  close() {
    clearInterval(this.sampler);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close().catch(() => {});
  }
}

export function pickAudioFormat() {
  const options = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/mp4;codecs=mp4a.40.2", "m4a"],
    ["audio/mp4", "m4a"],
  ];
  for (const [mime, ext] of options) {
    if (window.MediaRecorder?.isTypeSupported?.(mime)) return { mime, ext, contentType: mime.split(";")[0] };
  }
  return { mime: "", ext: "webm", contentType: "audio/webm" };
}

export class Recorder {
  constructor({ mic, outbox, sessionId, telemetry }) {
    this.mic = mic;
    this.outbox = outbox;
    this.sessionId = sessionId;
    this.telemetry = telemetry;
    this.format = pickAudioFormat();
    this.current = null;
    this.stats = { chunks: 0, bytes: 0, segment: null, errors: 0 };
  }

  // Start recording a named segment. keepLocal retains blobs for playback (mic check).
  start(segment, { keepLocal = false } = {}) {
    if (this.current) throw new Error(`already recording ${this.current.segment}`);
    this.segment = segment;
    this.keepLocal = keepLocal;
    this.localBlobs = [];
    this.current = this.startPart(segment, 0);
    this.stats.segment = segment;
  }

  startPart(segment, part) {
    const state = {
      id: uuid(), segment, part, seq: 0, bytes: 0,
      startWall: wall(), startT: t(), stopped: null,
    };
    const mr = new MediaRecorder(this.mic.stream, {
      ...(this.format.mime ? { mimeType: this.format.mime } : {}),
      audioBitsPerSecond: CONFIG.audioBitsPerSecond,
    });
    state.mr = mr;
    state.stopped = new Promise((resolve) => mr.addEventListener("stop", resolve, { once: true }));

    this.outbox.push({ kind: "rpc", fn: "register_recording", args: {
      p_id: state.id, p_segment: segment, p_part: part, p_mime: mr.mimeType || this.format.mime,
      p_started_wall: state.startWall, p_started_t: state.startT,
    } });

    mr.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return;
      const seq = state.seq++;
      state.bytes += event.data.size;
      this.stats.chunks++;
      this.stats.bytes += event.data.size;
      if (this.keepLocal) this.localBlobs.push(event.data);
      this.outbox.push({
        kind: "upload", bucket: "recordings", contentType: this.format.contentType, blob: event.data,
        path: `${this.sessionId}/${state.id}/${String(seq).padStart(6, "0")}.${this.format.ext}`,
      });
      this.telemetry.log("rec_chunk", { rec: state.id, seq, bytes: event.data.size });
    });
    mr.addEventListener("error", (event) => {
      this.stats.errors++;
      this.telemetry.log("rec_error", { rec: state.id, error: String(event.error?.message || event.error || "unknown") }, { milestone: true });
    });
    mr.addEventListener("start", () => {
      state.startT = t();
      this.telemetry.log("rec_start", { rec: state.id, segment, part, mime: mr.mimeType }, { milestone: true });
    });

    mr.start(CONFIG.chunkMs);
    state.rollover = setTimeout(() => this.rollover(), CONFIG.partMaxMs);
    return state;
  }

  async rollover() {
    const old = this.current;
    if (!old) return;
    this.current = this.startPart(old.segment, old.part + 1);
    await sleep(400); // overlap so the boundary loses nothing
    await this.stopPart(old);
  }

  async stopPart(state) {
    clearTimeout(state.rollover);
    if (state.mr.state !== "inactive") {
      state.mr.requestData();
      state.mr.stop();
    }
    await Promise.race([state.stopped, sleep(3000)]);
    const durationMs = Math.round(t() - state.startT);
    this.outbox.push({ kind: "rpc", fn: "finalize_recording", args: {
      p_recording: state.id, p_chunk_count: state.seq, p_bytes: state.bytes, p_duration_ms: durationMs,
    } });
    this.telemetry.log("rec_stop", { rec: state.id, segment: state.segment, part: state.part, chunks: state.seq, bytes: state.bytes, duration_ms: durationMs }, { milestone: true });
  }

  async stop() {
    const state = this.current;
    this.current = null;
    this.stats.segment = null;
    if (state) await this.stopPart(state);
    return this.keepLocal ? new Blob(this.localBlobs, { type: this.format.contentType }) : null;
  }

  isRecording() {
    return Boolean(this.current);
  }
}
