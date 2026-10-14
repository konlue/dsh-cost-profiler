# dsh-cost-profiler

[![npm](https://img.shields.io/npm/v/dsh-cost-profiler)](https://www.npmjs.com/package/dsh-cost-profiler)

Turn-level cost & performance profiler for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — attribution, not just a balance display.

The 4000-plugin DSH ecosystem has hundreds of "remaining quota" widgets, but nothing that answers *where* a session's tokens, seconds and cents actually went. This plugin folds the session's own event stream into a per-turn, per-model, per-tool profile and renders it on demand — **zero extra LLM calls, zero extra storage**.

[中文说明](./README.zh.md)

## What you get

- **`/cost`** slash command — instant session report with three granularities:
  - `/cost` / `/cost summary` — totals, per-model breakdown, slowest tools
  - `/cost full` — adds the per-turn timeline (wall / LLM ≈ / tools ≈ / tokens / est. cost per turn)
  - `/cost json` — machine-readable output for scripts and dashboards
- **Cross-session rollup** — the built-in panels are strictly per-session; this is the only place that answers "what did this week / this workspace cost me across all sessions":
  - `/cost week` / `/cost month` / `/cost all` — per-workspace and per-session tables with tokens and estimated cost (append `json` for machine output)
- **`cost_report`** tool — the model can pull the same session report mid-session when you ask "how much have we spent so far?"
- **`costProfiler` session projection** — the live aggregate behind both, also exposed on the client wire for dashboards.
- **Rendered output** — command results and tool cards render as real Markdown (see [Rendering](#rendering)).

### Sample output

```
Session cost $0.04 (est) · 2 turns · 27.6k in · 2.7k out · 88.5% cache hit · 58s wall

**Turns** 2 · **Messages** 2 · **Retries** 0
**Wall** 58s · **LLM ≈** 36.16s · **Tools ≈** 3.84s
**Tokens** 27.6k in · 213.1k cache hit (88.5%) · 2.7k out · 5.5k reasoning
**Estimated cost** $0.04 — API list prices (peak), USD

| Model route | In (uncached) | Cache hit | Cache write | Out | Reasoning | Msgs | Est. cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek/deepseek-v4-pro` | 15.2k | 115k | 0 | 1.9k | 3.4k | 1 | $0.03 |
| `deepseek/deepseek-flash` | 12.4k | 98.1k | 0 | 812 | 2.1k | 1 | $0.0053 |

**Slowest tools**

| Tool | Calls | Total | Max | Errors |
| --- | ---: | ---: | ---: | ---: |
| `bash` | 1 | 2.3s | 2.3s | 1 |
| `read_file` | 1 | 1.54s | 1.54s | 0 |
```

## Rendering

The same report text is rendered as Markdown in the chat, so tables arrive as
tables instead of as raw pipe characters:

- The `/cost` result renders through the chat's Markdown renderer
  (`conversation.chat.commandview`), and a `cost_report` call renders through the
  tool-call slot (`tool.call.toolview`).
- The row's collapsed label is the report's own first line, which is written as
  plain prose (`Session cost $0.04 (est) · 2 turns · …`) so it reads correctly
  even where Markdown is not rendered.
- Reports of up to 30 lines open by default; longer ones (`/cost full` on a busy
  session) start collapsed behind that label — click the row to expand.
- `/cost json` renders as a JSON code block, with the code block's copy button.
- If the client half is unavailable (or Markdown rendering fails), the card
  degrades to the monospace text the host sent. The report itself is always
  plain text end to end — the model always sees text, not markup.

Upgrading from a build without the client half? The plugin composition cache
holds a package's client declaration for the lifetime of the process, so the
app needs a full restart (not just a page reload) before the slot entries load.

## Install

Inside DSH (Plugins page, plugin manager tool, or CLI):

```
dsh plugin --profile <profile> add dsh-cost-profiler
```

Manual alternative — add the package to your profile's `package.json` dependencies and its name to `dsh.profile.bundles`, then run `pnpm install` in the profile directory. The bundle ships its own `cordis.patch.yml`, so no manual composition edits are needed.

## How it works

The plugin registers one pure [session projection](https://github.com/deepseek-ai/deepseek-harness) that folds durable session events (`assistant/message`, `tool/call` → `tool/result`, `turn/*`, `step/*`) into:

- token buckets per model route (`{provider}/{model}`), including cache read/write and reasoning tokens — taken from authoritative `assistant/message` settlements only, so streamed samples and aborted retries never double-count (same semantics as the official token-usage projection);
- tool durations from the `tool/call` → `tool/result` envelope-time delta, paired by `callId`, with per-tool call counts, totals, maxima and error counts;
- turn walls and an `LLM ≈` estimate (step wall minus tool wall).

Per-turn detail is capped (default 100 turns) while session totals always cover everything. State is plain JSON and survives projection checkpointing.

## Cost estimates

Costs are computed from **API list prices** and marked as estimates — subscription/quota billing may differ. Built-in defaults cover DeepSeek's published models (peak and off-peak schedules; off-peak is half of peak). Models without a configured price show `—` instead of a wrong number.

The report language is set by the `language` config key (`en` or `zh`, default `en`) — the host half cannot read the app's UI language, so unlike the card chrome the report body does not switch automatically. `/cost json` values stay English regardless, for script stability.

Set `showCosts: false` to omit costs entirely, or override prices per route in your profile's `cordis.patch.yml`:

```yaml
- id: cost-profiler
  name: dsh-cost-profiler
  config:
    showCosts: true
    offPeak: false          # set true to estimate with off-peak (half-peak) rates
    currency: USD           # display currency label
    detailTurns: 100        # per-turn detail kept for /cost full
    language: en            # report language: en | zh (card chrome follows the app UI)
    prices:                 # currency per 1M tokens
      deepseek/deepseek-flash: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 }
      # bare-model or "default" keys also work as fallbacks
      default: { input: 1, output: 2 }
```

## Cross-session rollup

`/cost week` (also `month`, `all`) reads **locally stored sessions** and rolls them up — per-workspace totals plus a per-session table sorted by estimated cost. Nothing like this exists in the built-in panels, which are strictly per-session.

Where the data comes from, in order of preference:

1. this plugin's own checkpoint for that session (per-model-route buckets — priced most accurately);
2. the app's official `tokenUsage` checkpoint (session totals without routes — priced via the session's last-used model, or your `default` price);
3. replaying the session log directly (no checkpoint needed).

Notes:

- **Read-only and privacy-bounded**: the scan reads `~/.dsh` (`$DSH_HOME` respected), touches only titles, timestamps and usage/timing numbers — never message content — and writes nothing.
- The current session's last events may lag by one checkpoint flush (typically seconds).
- Sessions with no profiled activity are skipped; a window with nothing in it renders a pointer to `/cost all` rather than an empty table.
- The `cost_report` model tool deliberately stays session-scoped — cross-session tables would bloat model context.

## Notes & limitations

- `LLM ≈` is derived from step timers, not per-request timings — treat it as an approximation.
- The in-session profile covers the current session (subagent sessions have their own); cross-session rollup is its own feature (see above).
- The `/cost` command reports text only; it does not enter model context. `/cost json` is the integration point for dashboards.
- Card chrome (running/JSON/error labels, code-block buttons) follows the app's UI language (English/Chinese) through the app's locale registry; the report body itself is host-generated English.

## Compatibility

- DSH `0.2.0-rc.1` and later `0.2.0-rc.x` (peer range `^0.2.0-rc.1`), cordis `^4.0.1`, Node ≥ 20.
- The host half is plain ESM with no build step and no native modules. The client half is a hand-written classic script (no bundler) that registers two UI slots and degrades to plain text if the chat UI is absent.

## Development

```
npm install      # (not required for tests)
node --test      # 44 unit tests over the fold/report/prices/history layers and the client half
```

## License

MIT — see [LICENSE](./LICENSE).
