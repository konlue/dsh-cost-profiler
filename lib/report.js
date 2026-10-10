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
import { aggregateSessions } from "./history.js";
import { tFor } from "./i18n.js";

export const MODES = ["summary", "full", "json"];

const MAX_TOOL_ROWS = 8;
const MAX_TURN_ROWS = 30;
const MAX_SESSION_ROWS = 15;
const MAX_WORKSPACE_ROWS = 8;

/** Cross-session scopes (see ./history.js); `null` scope = current session. */
export const SCOPES = ["week", "month", "all"];

/** English scope labels — also the language-stable values used in JSON output. */
const SCOPE_LABELS = { week: "last 7 days", month: "last 30 days", all: "all time" };

const SCOPE_KEYS = { week: "scopeWeek", month: "scopeMonth", all: "scopeAll" };

/**
 * Parse the raw text after `/cost` into `{ scope, format }`:
 *   - `` / `summary` / `full` / `json`       → current session
 *   - `week` / `month` / `all` [summary|json] → cross-session rollup
 * Returns `null` for unknown input.
 */
export function parseMode(rawInput) {
  const parts = (rawInput ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { scope: null, format: "summary" };
  if (parts.length === 1 && MODES.includes(parts[0])) return { scope: null, format: parts[0] };
  if (parts.length === 1 && SCOPES.includes(parts[0])) return { scope: parts[0], format: "summary" };
  if (parts.length === 2 && SCOPES.includes(parts[0]) && MODES.includes(parts[1]) && parts[1] !== "full") {
    return { scope: parts[0], format: parts[1] };
  }
  return null;
}

export const USAGE = "Usage: /cost [summary|full|json] or /cost [week|month|all] [summary|json]";

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

function emptyReport(mode, tr) {
  if (mode === "json") {
    return `${JSON.stringify({ status: "empty", message: "No profiled activity in this session yet." }, null, 2)}\n`;
  }
  return [tr("emptySession")].join("\n");
}

/**
 * First line of every text report. It doubles as the collapsed label of the
 * client card, as the whole visible output when the client half is unavailable,
 * and as the first line of the raw text the model reads, so it must stand on
 * its own as plain prose — no Markdown markers, no trailing continuation.
 */
function headline(tr, turns, tokens, wallMs, costText) {
  const cacheHit = tokens.input + tokens.cacheRead > 0 ? tokens.cacheRead / (tokens.input + tokens.cacheRead) : 0;
  return [
    costText === null ? tr("headlineTrackingOff") : tr("headlineCost", { cost: costText }),
    `${turns} ${tr(turns === 1 ? "turn" : "turns")}`,
    tr("inTokens", { n: fmtTokens(tokens.input) }),
    tr("outTokens", { n: fmtTokens(tokens.output) }),
    tr("cacheHitPct", { pct: fmtPct(cacheHit) }),
    tr("wallTime", { n: fmtMs(wallMs) }),
  ].join(" · ");
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

function routesTable(rows, cfg, showCost, tr) {
  const head = [tr("routeHeader"), tr("inUncachedHeader"), tr("cacheHitHeader"), tr("cacheWriteHeader"), tr("outHeader"), tr("reasoningHeader"), tr("msgsHeader")];
  if (showCost) head.push(tr("estCostHeader"));
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

function toolsTable(state, tr) {
  const tools = Object.entries(state.totals.tools);
  if (tools.length === 0) return null;
  tools.sort(([, a], [, b]) => b.ms - a.ms || b.count - a.count);
  const lines = [
    `| ${tr("toolHeader")} | ${tr("callsHeader")} | ${tr("totalHeader")} | ${tr("maxHeader")} | ${tr("errorsHeader")} |`,
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, agg] of tools.slice(0, MAX_TOOL_ROWS)) {
    const total = agg.unknown > 0 && agg.ms === 0 ? "n/a" : fmtMs(agg.ms);
    lines.push(`| \`${name}\` | ${agg.count} | ${total} | ${fmtMs(agg.max)} | ${agg.errs} |`);
  }
  if (tools.length > MAX_TOOL_ROWS) {
    lines.push("", tr("moreTools", { n: tools.length - MAX_TOOL_ROWS }));
  }
  return lines.join("\n");
}

function turnsTable(state, cfg, showCost, tr) {
  const turns = state.turns;
  if (turns.length === 0) return null;
  const shown = turns.slice(-MAX_TURN_ROWS);
  const symbol = currencySymbol(cfg.currency);
  const lines = [
    tr("turnsKept", { shown: shown.length, total: turns.length }),
    "",
    `| # | ${tr("wallLabel")} | ${tr("llmLabel")} | ${tr("toolsLabel")} | ${tr("inUncachedHeader")} | ${tr("outHeader")} | ${tr("cacheHitHeader")} | ${tr("estCostHeader")} |`,
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
    lines.push("", tr("turnsTrimmed"));
  }
  return lines.join("\n");
}

function summaryLines(state, cfg, showCost, tr) {
  const t = tokenTotals(state.totals.routes);
  const { rows, unpriced, estimate, symbol } = routeRows(state, cfg);
  const lines = [
    headline(tr, state.totals.turns, t, state.totals.wallMs, showCost ? fmtCost(estimate, symbol) : null),
    "",
    `**${tr("turnsLabel")}** ${state.totals.turns} · **${tr("messagesLabel")}** ${state.totals.msgs} · **${tr("retriesLabel")}** ${state.totals.retries}`,
    `**${tr("wallLabel")}** ${fmtMs(state.totals.wallMs)} · **${tr("llmLabel")}** ${fmtMs(state.totals.llmMs)} · **${tr("toolsLabel")}** ${fmtMs(state.totals.toolMs)}`,
    `**${tr("tokensLabel")}** ${tr("inTokens", { n: fmtTokens(t.input) })} · ${tr("cacheHitPct", { pct: fmtPct(t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0) })} · ${tr("outTokens", { n: fmtTokens(t.output) })} · ${fmtTokens(t.reasoning)} ${tr("reasoningLabel")}`,
  ];
  if (showCost) {
    lines.push(
      `**${tr("estimatedCostLabel")}** ${fmtCost(estimate, symbol)} ${tr("listPrices", { schedule: tr(cfg.offPeak ? "offPeak" : "peak"), currency: cfg.currency })}`,
    );
  }
  lines.push("", routesTable(rows, cfg, showCost, tr));
  const tools = toolsTable(state, tr);
  if (tools) lines.push("", `**${tr("slowestTools")}**`, "", tools);
  if (showCost) {
    const notes = [tr("costsNote")];
    if (unpriced.length > 0) {
      notes.push(tr("noPrice", { routes: unpriced.map((k) => `\`${k}\``).join(", ") }));
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
  const tr = tFor(cfg.language);
  if (mode === "json") {
    if (!state) return emptyReport(mode, tr);
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

  if (!state || (state.totals.turns === 0 && state.totals.msgs === 0)) return emptyReport(mode, tr);

  const showCost = cfg.showCosts === true;
  const lines = summaryLines(state, cfg, showCost, tr);
  if (mode === "full") {
    const turns = turnsTable(state, cfg, showCost, tr);
    if (turns) lines.push("", turns);
  }
  return lines.join("\n");
}

/** Markdown table cells must not contain raw pipes or line breaks. */
function cell(text, max = 28) {
  const flat = String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fmtDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sessionsEmptyReport(scope, tr) {
  const window = tr(SCOPE_KEYS[scope] ?? "scopeAll");
  return [
    tr("sessionsEmptyWindow", { window }),
    "",
    tr("sessionsEmptyHint", { window }),
  ].join("\n");
}

/**
 * Render the cross-session rollup produced by ./history.js.
 * @param collected `{ records, errors }` from `collectSessions`
 * @param cfg normalized config `{ showCosts, currency, offPeak, prices }`
 * @param scope one of {@link SCOPES}
 * @param format `"summary"` or `"json"`
 */
export function renderSessionsReport(collected, cfg, scope = "all", format = "summary") {
  const tr = tFor(cfg.language);
  const showCost = cfg.showCosts === true;
  const { totals, byWorkspace, sessions } = aggregateSessions(collected.records ?? [], cfg);
  // JSON keeps the English window label: machine consumers get a
  // language-stable contract regardless of the report language.
  const window = SCOPE_LABELS[scope] ?? scope;

  if (format === "json") {
    return `${JSON.stringify(
      {
        scope,
        window,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          workspace: s.workspaceName,
          cwd: s.cwd,
          createdAt: s.createdAt,
          lastActivity: s.activityMs,
          source: s.source,
          turns: s.usage.turns,
          tokens: s.tokens,
          routes: s.routes,
          ...(showCost ? { cost: s.cost } : {}),
        })),
        byWorkspace,
        totals: { ...totals, unpriced: totals.unpriced },
        ...(showCost ? { cost: { currency: cfg.currency, basis: "api-list-prices", offPeak: cfg.offPeak, estimate: totals.estimate, unpricedRoutes: totals.unpriced } } : {}),
        ...(collected.errors?.length ? { warnings: collected.errors } : {}),
      },
      null,
      2,
    )}\n`;
  }

  if (sessions.length === 0) return sessionsEmptyReport(scope, tr);

  const costText = showCost ? (totals.estimate > 0 ? fmtCost(totals.estimate, currencySymbol(cfg.currency)) : fmtCost(0, currencySymbol(cfg.currency))) : null;
  const headline = [
    costText === null ? tr("sessionsTrackingOff") : tr("sessionsHeadline", { cost: costText }),
    tr(totals.sessions === 1 ? "sessionsCountOne" : "sessionsCountMany", { n: totals.sessions }),
    `${totals.turns} ${tr(totals.turns === 1 ? "turn" : "turns")}`,
    tr("inTokens", { n: fmtTokens(totals.tokens.input) }),
    tr("outTokens", { n: fmtTokens(totals.tokens.output) }),
    tr("cacheHitPct", { pct: fmtPct(totals.tokens.input + totals.tokens.cacheRead > 0 ? totals.tokens.cacheRead / (totals.tokens.input + totals.tokens.cacheRead) : 0) }),
    tr(SCOPE_KEYS[scope] ?? "scopeAll"),
  ].join(" · ");

  const lines = [headline];

  if (byWorkspace.length > 1 || byWorkspace[0]?.workspace !== "unknown") {
    const head = [tr("workspaceHeader"), tr("sessionsCountHeader"), tr("inUncachedHeader"), tr("cacheHitHeader"), tr("outHeader")];
    if (showCost) head.push(tr("estCostHeader"));
    lines.push("", `| ${head.join(" | ")} |`, `| ${head.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`);
    for (const ws of byWorkspace.slice(0, MAX_WORKSPACE_ROWS)) {
      const cells = [
        cell(ws.workspace),
        String(ws.sessions),
        fmtTokens(ws.tokens.input),
        fmtTokens(ws.tokens.cacheRead),
        fmtTokens(ws.tokens.output),
      ];
      if (showCost) cells.push(ws.priced ? fmtCost(ws.estimate, currencySymbol(cfg.currency)) : "—");
      lines.push(`| ${cells.join(" | ")} |`);
    }
    if (byWorkspace.length > MAX_WORKSPACE_ROWS) {
      lines.push("", tr("moreWorkspaces", { n: byWorkspace.length - MAX_WORKSPACE_ROWS, scope }));
    }
  }

  const sorted = [...sessions].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.activityMs - a.activityMs);
  const head = [tr("sessionHeader"), tr("workspaceHeader"), tr("lastActiveHeader"), tr("turnsLabel"), tr("inUncachedHeader"), tr("cacheHitHeader"), tr("outHeader")];
  if (showCost) head.push(tr("estCostHeader"));
  lines.push("", `| ${head.join(" | ")} |`, `| ${head.map((_, i) => (i < 3 ? "---" : "---:")).join(" | ")} |`);
  for (const session of sorted.slice(0, MAX_SESSION_ROWS)) {
    const cells = [
      cell(session.title ?? session.id ?? tr("untitled")),
      cell(session.workspaceName),
      fmtDate(session.activityMs),
      String(session.usage.turns),
      fmtTokens(session.tokens.input),
      fmtTokens(session.tokens.cacheRead),
      fmtTokens(session.tokens.output),
    ];
    if (showCost) cells.push(session.cost !== null ? fmtCost(session.cost, currencySymbol(cfg.currency)) : "—");
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (sorted.length > MAX_SESSION_ROWS) {
    lines.push("", tr("moreSessions", { n: sorted.length - MAX_SESSION_ROWS, scope }));
  }

  if (showCost) {
    const notes = [tr("privacyNote")];
    if (totals.unpriced.length > 0) {
      notes.push(tr("noPrice", { routes: totals.unpriced.map((k) => `\`${k}\``).join(", ") }));
    }
    if (collected.errors?.length) notes.push(tr("skippedSessions", { n: collected.errors.length }));
    lines.push("", ...notes);
  }

  return lines.join("\n");
}
