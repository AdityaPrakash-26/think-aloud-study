// Supabase access for participants: RPC calls (session-token checked server side)
// and inserts into the session's own Storage folder. Nothing else is reachable.

import { CONFIG } from "./config.js";
import { retry } from "./util.js";

class ApiError extends Error {
  constructor(message, { status = 0, code = null, transient = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}

export class Api {
  constructor() {
    this.client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    this.sessionId = null;
    this.token = null;
  }

  setSession(sessionId, token) {
    this.sessionId = sessionId;
    this.token = token;
  }

  // Raw RPC; session args are injected for functions that take them.
  async rpc(fn, args = {}) {
    const payload = fn === "start_session" ? args : { p_session: this.sessionId, p_token: this.token, ...args };
    let result;
    try {
      result = await this.client.rpc(fn, payload);
    } catch (err) {
      throw new ApiError(`${fn}: ${err?.message || err}`, { transient: true });
    }
    if (result.error) {
      const status = result.status || 0;
      throw new ApiError(`${fn}: ${result.error.message}`, {
        status, code: result.error.code, transient: status === 0 || status >= 500 || status === 429,
      });
    }
    return result.data;
  }

  // RPC with immediate retries for interactive steps (the outbox handles background ones).
  call(fn, args = {}, attempts = 5) {
    return retry(() => this.rpc(fn, args), { attempts, shouldRetry: (err) => err.transient });
  }

  async uploadObject(bucket, path, blob, contentType) {
    const { error } = await this.client.storage.from(bucket).upload(path, blob, { contentType, upsert: false, cacheControl: "3600" });
    if (!error) return;
    // A retried chunk that already arrived is a success.
    if (error.statusCode === "409" || /already exists|Duplicate/i.test(error.message || "")) return;
    const status = Number(error.statusCode) || 0;
    // 4xx (e.g. RLS refusal for a closed session, payload too large) won't fix itself.
    const transient = status === 0 || status === 429 || status >= 500;
    throw new ApiError(`upload ${path}: ${error.message}`, { status, transient });
  }
}
