# Changelog

## 0.1.0 — 2026-10-07

Initial release.

- `costProfiler` session projection: per-turn token/latency attribution with
  per-model-route token buckets (cache read/write, reasoning), tool timing
  aggregated by callId pairing, retry counting, bounded per-turn detail with
  whole-session totals, checkpoint-safe plain-JSON state.
- `/cost [summary|full|json]` slash command (falls back to `/cost-report` on
  name collision).
- `cost_report` model tool so the agent can pull the profile on request.
- Built-in DeepSeek API list prices (peak/off-peak) with per-route overrides,
  custom currency, and `showCosts: false` opt-out.
- Wire view (`costProfiler` projection key) for future client UI panels.
