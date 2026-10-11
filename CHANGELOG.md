# Changelog

## 0.1.0 — 2026-10-07

Initial release.

- `costProfiler` session projection: per-turn token/latency attribution with
  per-model-route token buckets (cache read/write, reasoning), tool timing
  aggregated by callId pairing, retry counting, bounded per-turn detail with
  whole-session totals, checkpoint-safe plain-JSON state.
- `/cost [summary|full|json]` slash command (falls back to `/cost-report` on
  name collision).
- Cross-session rollup: `/cost week|month|all [summary|json]` scans locally
  stored sessions and answers "what did this week / this workspace cost across
  all sessions" — per-workspace and per-session tables nothing in the built-in
  panels provides. Data precedence: this plugin's own checkpoint (per-route),
  the official `tokenUsage` checkpoint (priced via the last-used model), then
  session-log replay. Read-only; titles and usage numbers only, never message
  content.
- `cost_report` model tool so the agent can pull the profile on request.
- Built-in DeepSeek API list prices (peak/off-peak) with per-route overrides,
  custom currency, `showCosts: false` opt-out, and a `language` config key
  (`en` | `zh`, default `en`) for the report body and command errors — the
  host half cannot read the app's UI language, so the body is config-driven
  while card chrome follows the app UI automatically.
- Wire view (`costProfiler` projection key) for dashboards.
- Client half (`lib/client.js`, hand-written classic script, no build step):
  renders the `/cost` result through the chat Markdown renderer
  (`conversation.chat.commandview`, keys `cost` and `cost-report`) and the
  `cost_report` result through the tool-call slot (`tool.call.toolview`, key
  `cost_report`). Reports up to 30 lines open by default, longer ones collapse
  behind their headline, `/cost json` becomes a JSON code block. Both cards
  degrade to monospace text — with an inner error boundary, since a crashed
  slot entry is retired rather than falling back to the generic card. Card
  chrome (running/JSON/error labels, code-block buttons) is bilingual through
  the app's locale registry (`cost-profiler` namespace, English/Chinese) and
  follows the app UI language.
- Report line 1 is self-contained plain prose (`Session cost $0.04 (est) ·
  2 turns · 27.6k in · 2.7k out · 88.5% cache hit · 58s wall`) rather than a
  Markdown heading, so it reads correctly as a collapsed label and in the raw
  fallback.
