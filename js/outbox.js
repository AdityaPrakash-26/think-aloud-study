// Durable outbox: every Storage upload and bookkeeping RPC is persisted to
// IndexedDB before it is sent, then retried with backoff until it succeeds.
// Uploads run two at a time; RPCs run strictly in order (register before
// finalize). Survives reloads: leftover jobs resume on the next page load.

import { sleep } from "./util.js";

const DB_NAME = "study-outbox";
const STORE = "jobs";
const MAX_BACKOFF_MS = 60000;
// A job that keeps failing with a non-transient error (bad request, constraint
// violation) is parked as "dead" so it can never block the ordered RPC lane.
const MAX_PERMANENT_FAILURES = 4;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const result = fn(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export class Outbox {
  constructor(api) {
    this.api = api;
    this.db = null;
    this.queue = []; // in-memory mirror, ordered by seq
    this.counter = 0;
    this.active = { upload: 0, rpc: 0 };
    this.limits = { upload: 2, rpc: 1 };
    this.stats = { ok: 0, failedAttempts: 0, lastOkWall: null, lastError: null, bytesSent: 0 };
    this.listeners = new Set();
  }

  async open() {
    try {
      this.db = await openDb();
      const rows = await tx(this.db, "readonly", (store) => store.getAll());
      this.queue = rows.sort((a, b) => a.seq - b.seq);
      this.counter = this.queue.length ? this.queue[this.queue.length - 1].seq + 1 : 0;
    } catch (err) {
      this.db = null; // private mode etc.: fall back to memory only
      this.stats.lastError = `indexeddb: ${err?.message || err}`;
    }
    this.pump();
    addEventListener("online", () => this.pump());
    return this.queue.length;
  }

  // job: {kind: "upload", bucket, path, blob, contentType} | {kind: "rpc", fn, args}
  async push(job) {
    const entry = { ...job, id: crypto.randomUUID(), seq: Date.now() * 1000 + (this.counter++ % 1000),
                    attempts: 0, notBefore: 0, size: job.blob?.size || 0 };
    this.queue.push(entry);
    if (this.db) {
      try { await tx(this.db, "readwrite", (store) => store.put(entry)); } catch { /* memory copy still sends */ }
    }
    this.pump();
    return entry.id;
  }

  pending() {
    const live = this.queue.filter((j) => !j.dead);
    return {
      jobs: live.length,
      uploads: live.filter((j) => j.kind === "upload").length,
      bytes: live.reduce((sum, j) => sum + (j.size || 0), 0),
      dead: this.queue.length - live.length,
      ...this.stats,
    };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pump() {
    const now = Date.now();
    for (const lane of ["rpc", "upload"]) {
      while (this.active[lane] < this.limits[lane]) {
        // RPCs must stay ordered: only the head RPC may run, and only when due.
        const candidates = this.queue.filter((j) => j.kind === lane && !j.running && !j.dead);
        const job = lane === "rpc" ? candidates[0] : candidates.find((j) => j.notBefore <= now);
        if (!job || job.notBefore > now) break;
        this.run(job, lane);
      }
    }
    const next = this.queue.filter((j) => !j.running && !j.dead).reduce((m, j) => Math.min(m, j.notBefore), Infinity);
    clearTimeout(this.timer);
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.pump(), Math.max(50, next - now));
  }

  async run(job, lane) {
    job.running = true;
    this.active[lane]++;
    try {
      if (job.kind === "upload") {
        await this.api.uploadObject(job.bucket, job.path, job.blob, job.contentType);
        this.stats.bytesSent += job.size;
      } else {
        await this.api.rpc(job.fn, job.args);
      }
      this.queue = this.queue.filter((j) => j !== job);
      if (this.db) tx(this.db, "readwrite", (store) => store.delete(job.id)).catch(() => {});
      this.stats.ok++;
      this.stats.lastOkWall = Date.now();
    } catch (err) {
      job.attempts++;
      if (!err?.transient) job.permanentFailures = (job.permanentFailures || 0) + 1;
      this.stats.failedAttempts++;
      this.stats.lastError = `${job.kind}:${job.fn || job.path}: ${err?.message || err}`.slice(0, 300);
      job.notBefore = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(job.attempts, 6));
      if (job.permanentFailures >= MAX_PERMANENT_FAILURES) job.dead = true;
      if (this.db) tx(this.db, "readwrite", (store) => store.put({ ...job, running: false })).catch(() => {});
    } finally {
      job.running = false;
      this.active[lane]--;
      this.listeners.forEach((fn) => fn(this.pending()));
      this.pump();
    }
  }

  // Wait until everything is sent (or the timeout passes). Returns jobs left.
  async drain(timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    for (const job of this.queue) job.notBefore = 0;
    this.pump();
    while (this.pending().jobs && Date.now() < until) await sleep(250);
    return this.pending().jobs;
  }
}
