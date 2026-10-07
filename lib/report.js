/**
 * Markdown / JSON report rendering for the cost profiler.
 * Consumes the projection's host state (see ./fold.js) plus the normalized
 * plugin config, and produces the text shared by the /cost command and the
 * cost_report tool.
 *
 * @module dsh-cost-profiler/report
 */

import { tokenTotals } from "./fold.js";
import { resolvePrice, routeCost, CURRENCY_SYMBOLS } from "./prices.js";

export const MODES = ["summary", "full", "json"];

const MAX_TOOL_ROWS = 8;
const MAX_TURN_ROWS = 30;

/** Parse the raw text after `/cost`; returns a valid mode or null. */
export function parseMode(rawInput) {
  const input = (rawInput ?? "").trim().toLowerCase();
  if (input === "") return "summary";
  return MODES.includes(input) ? input : null;
}

export const USAGE = "Usage: /cost [summary|full|json]";

function trimNum(text) {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimNum((n / 1000).toFixed(1))}k`;
  return `${trimNum((n / 1_000_000).toFixed(2))}M`;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trimNum((ms / 1000).toFixed(2))}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

export function fmtCost(usd, symbol) {
  const abs = Math.abs(usd);
  // Money keeps its trailing zeros ($0.53, $0.00); sub-cent values get 4 decimals.
  const body = abs > 0 && abs < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
  return `${symbol}${body}`;
}

function fmtPct(frac) {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  return `${trimNum((frac * 100).toFixed(1))}%`;
}

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

function emptyReport(mode) {
  if (mode === "json") {
    return `${JSON.stringify({ status: "empty", message: "No profiled activity in this session yet." }, null, 2)}\n`;
  }
  return [
    "### Session cost profile",
    "",
    "No profiled activity in this session yet. The profile builds up as turns run — run `/cost` again after the next exchange.",
  ].join("\n");
}

function routeRows(state, cfg) {
  const entries = Object.entries(state.totals.routes);
  const symbol = currencySymbol(cfg.currency);
  const rows = [];
  const unpriced = [];
  let estimate = 0;
  for (const [key, bucket] of entries) {
    const price = resolvePrice(key, cfg.prices, cfg.offPeak);
    const cost = routeCost(bucket, price);
    if (cost === null) unpriced.push(key);
    else estimate += cost;
    rows.push({ key, bucket, cost, priced: cost !== null });
  }
  rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.bucket.output - a.bucket.output);
  return { rows, unpriced, estimate, symbol };
}

function routesTable(rows, cfg, showCost) {
  const head = ["Model route", "In (uncached)", "Cache hit", "Cache write", "Out", "Reasoning", "Msgs"];
  if (showCost) head.push("Est. cost");
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
  ];
  for (const { key, bucket, cost, priced } of rows) {
    const cells = [
      `\`${key}\``,
      fmtTokens(bucket.input),
      fmtTokens(bucket.cacheRead),
      fmtTokens(bucket.cacheWrite),
      fmtTokens(bucket.output),
      fmtTokens(bucket.reasoning),
      String(bucket.msgs),
    ];
    if (showCost) cells.push(priced ? fmtCost(cost, currencySymbol(cfg.currency)) : "—");
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function toolsTable(state) {
  const tools = Object.entries(state.totals.tools);
  if (tools.length === 0) return null;
  tools.sort(([, a], [, b]) => b.ms - a.ms || b.count - a.count);
  const lines = [
    "| Tool | Calls | Total | Max | Errors |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, agg] of tools.slice(0, MAX_TOOL_ROWS)) {
    const total = agg.unknown > 0 && agg.ms === 0 ? "n/a" : fmtMs(agg.ms);
    lines.push(`| \`${name}\` | ${agg.count} | ${total} | ${fmtMs(agg.max)} | ${agg.errs} |`);
  }
  if (tools.length > MAX_TOOL_ROWS) {
    lines.push("", `_…and ${tools.length - MAX_TOOL_ROWS} more tools (see \`/cost json\`)._`);
  }
  return lines.join("\n");
}

function turnsTable(state, cfg, showCost) {
  const turns = state.turns;
  if (turns.length === 0) return null;
  const shown = turns.slice(-MAX_TURN_ROWS);
  const symbol = currencySymbol(cfg.currency);
  const lines = [
    `**Turns** (last ${shown.length} of ${turns.length} kept)`,
    "",
    "| # | Wall | LLM ≈ | Tools ≈ | In | Out | Cache hit | Est. cost |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const turn of shown) {
    const tokens = tokenTotals(turn.routes);
    let cost = 0;
    let priced = false;
    if (showCost) {
      for (const [key, bucket] of Object.entries(turn.routes)) {
        const c = routeCost(bucket, resolvePrice(key, cfg.prices, cfg.offPeak));
        if (c !== null) {
          cost += c;
          priced = true;
        }
      }
    }
    lines.push(
      `| ${turn.turn} | ${turn.wallMs === null ? "…" : fmtMs(turn.wallMs)} | ${fmtMs(turn.llmMs)} | ${fmtMs(turn.toolMs)} | ${fmtTokens(tokens.input)} | ${fmtTokens(tokens.output)} | ${fmtTokens(tokens.cacheRead)} | ${
        showCost ? (priced ? fmtCost(cost, symbol) : "—") : "n/a"
      } |`,
    );
  }
  if (turns.length > shown.length) {
    lines.push("", `_Older turns were trimmed from the detail view; the totals above still cover the whole session._`);
  }
  return lines.join("\n");
}

function summaryLines(state, cfg, showCost) {
  const t = tokenTotals(state.totals.routes);
  const { rows, unpriced, estimate, symbol } = routeRows(state, cfg);
  const lines = [
    "### Session cost profile",
    "",
    `**Turns** ${state.totals.turns} · **Messages** ${state.totals.msgs} · **Retries** ${state.totals.retries}`,
    `**Wall** ${fmtMs(state.totals.wallMs)} · **LLM ≈** ${fmtMs(state.totals.llmMs)} · **Tools ≈** ${fmtMs(state.totals.toolMs)}`,
    `**Tokens** ${fmtTokens(t.input)} in · ${fmtTokens(t.cacheRead)} cache hit (${fmtPct(t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0)}) · ${fmtTokens(t.output)} out · ${fmtTokens(t.reasoning)} reasoning`,
  ];
  if (showCost) {
    lines.push(`**Estimated cost** ${fmtCost(estimate, symbol)} — API list prices (${cfg.offPeak ? "off-peak" : "peak"}), ${cfg.currency}`);
  }
  lines.push("", routesTable(rows, cfg, showCost));
  const tools = toolsTable(state);
  if (tools) lines.push("", "**Slowest tools**", "", tools);
  if (showCost) {
    const notes = ["_Costs are API list-price estimates for orientation only — subscription/quota billing may differ._"];
    if (unpriced.length > 0) {
      notes.push(`_No price configured for: ${unpriced.map((k) => `\`${k}\``).join(", ")} — set them under the \`prices\` config key._`);
    }
    lines.push("", ...notes);
  }
  return lines;
}

/**
 * Render the session cost profile.
 * @param state projection host state (or null before any activity)
 * @param cfg normalized config `{ showCosts, currency, offPeak, prices }`
 * @param mode one of {@link MODES}
 */
export function renderReport(state, cfg, mode = "summary") {
  if (mode === "json") {
    if (!state) return emptyReport(mode);
    const t = tokenTotals(state.totals.routes);
    const { rows, unpriced, estimate } = routeRows(state, cfg);
    const payload = {
      totals: {
        turns: state.totals.turns,
        msgs: state.totals.msgs,
        retries: state.totals.retries,
        llmMs: state.totals.llmMs,
        toolMs: state.totals.toolMs,
        wallMs: state.totals.wallMs,
        tokens: t,
      },
      routes: state.totals.routes,
      tools: state.totals.tools,
      turns: state.turns,
      ...(cfg.showCosts
        ? {
            cost: {
              currency: cfg.currency,
              basis: "api-list-prices",
              offPeak: cfg.offPeak,
              estimate,
              unpricedRoutes: unpriced,
            },
          }
        : {}),
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  if (!state || (state.totals.turns === 0 && state.totals.msgs === 0)) return emptyReport(mode);

  const showCost = cfg.showCosts === true;
  const lines = summaryLines(state, cfg, showCost);
  if (mode === "full") {
    const turns = turnsTable(state, cfg, showCost);
    if (turns) lines.push("", turns);
  }
  return lines.join("\n");
}
