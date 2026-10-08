# dsh-cost-profiler

Turn-level cost & performance profiler for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — attribution, not just a balance display.

The 4000-plugin DSH ecosystem has hundreds of "remaining quota" widgets, but nothing that answers *where* a session's tokens, seconds and cents actually went. This plugin folds the session's own event stream into a per-turn, per-model, per-tool profile and renders it on demand — **zero extra LLM calls, zero extra storage**.

[中文说明](./README.zh.md)

## What you get

- **`/cost`** slash command — instant session report with three granularities:
  - `/cost` / `/cost summary` — totals, per-model breakdown, slowest tools
  - `/cost full` — adds the per-turn timeline (wall / LLM ≈ / tools ≈ / tokens / est. cost per turn)
  - `/cost json` — machine-readable output for scripts and dashboards
- **`cost_report`** tool — the model can pull the same report mid-session when you ask "how much have we spent so far?"
- **`costProfiler` session projection** — the live aggregate behind both, also exposed on the client wire for future UI panels.

### Sample output

```
### Session cost profile

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

Set `showCosts: false` to omit costs entirely, or override prices per route in your profile's `cordis.patch.yml`:

```yaml
- id: cost-profiler
  name: dsh-cost-profiler
  config:
    showCosts: true
    offPeak: false          # estimate with off-peak (half-peak) rates
    currency: USD           # display currency label
    detailTurns: 100        # per-turn detail kept for /cost full
    prices:                 # currency per 1M tokens
      deepseek/deepseek-flash: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 }
      # bare-model or "default" keys also work as fallbacks
      default: { input: 1, output: 2 }
```

## Notes & limitations

- `LLM ≈` is derived from step timers, not per-request timings — treat it as an approximation.
- The profile covers the current session (subagent sessions have their own); cross-session rollup is planned.
- The `/cost` command reports text only; it does not enter model context. `/cost json` is the integration point for dashboards.

## Compatibility

- DSH `0.2.0-rc.1` and later `0.2.0-rc.x` (peer range `^0.2.0-rc.1`), cordis `^4.0.1`, Node ≥ 20.
- Pure host-side plugin — no client UI, no native modules, no build step.

## Development

```
npm install      # (not required for tests)
node --test      # 17 unit tests over the pure fold/report/prices layers
```

## License

MIT — see [LICENSE](./LICENSE).
