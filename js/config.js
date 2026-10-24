// Deployment settings. The publishable key is meant to be public: participants can
// only call the study's RPC functions (each checks a per-session secret token) and
// upload into their own session folder. Everything else is admin-only.
export const CONFIG = {
  supabaseUrl: "https://wahgtmyrnwcwjnzhcvgp.supabase.co",
  supabaseKey: "sb_publishable_EJZh5RXeOvJPtXyyHK_WNg_gW1z3bJj",

  audioBitsPerSecond: 32000,      // Opus, mono: ~14 MB per hour
  chunkMs: 5000,                  // MediaRecorder timeslice; each chunk uploads on its own
  telemetryFlushMs: 10000,
  heartbeatMs: 15000,
  defaultNudgeSilenceMs: 60000,
  minWindowWidth: 1100,
  estimatedMinutes: 40,
};
