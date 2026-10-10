/**
 * dsh-cost-profiler — turn-level cost & performance profiler for the
 * DeepSeek Harness.
 *
 * Registers one pure session projection (`costProfiler`) that folds the
 * session event stream into per-turn token/latency/cost attribution plus
 * whole-session tool timings, a human-facing `/cost` slash command, and a
 * model-facing `cost_report` tool. Both read the projection — no LLM calls,
 * no extra storage.
 *
 * @module dsh-cost-profiler
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { STATE_VERSION, applyEvent, wireView, DEFAULT_DETAIL_TURNS } from "./fold.js";
import { renderReport, renderSessionsReport, parseMode, MODES } from "./report.js";
import { normalizePrices } from "./prices.js";
import { collectSessions, SCOPE_DAYS } from "./history.js";
import { tFor } from "./i18n.js";

const name = "cost-profiler";

const inject = ["sessionProjections", "commands", "tools"];

const Config = z.object({
  showCosts: z.boolean().default(true),
  currency: z.string().default("USD"),
  offPeak: z.boolean().default(false),
  detailTurns: z.number().default(DEFAULT_DETAIL_TURNS),
  language: z.string().default("en"),
  prices: z.any().default({}),
});

/** Permissive checkpoint schema: the fold owns the exact shape. */
const stateSchema = zod.union([zod.null(), zod.object({}).passthrough()]);

const wireSchema = zod
  .object({
    turns: zod.number().int().nonnegative(),
    msgs: zod.number().int().nonnegative(),
    retries: zod.number().int().nonnegative(),
    input: zod.number().int().nonnegative(),
    output: zod.number().int().nonnegative(),
    cacheRead: zod.number().int().nonnegative(),
    cacheWrite: zod.number().int().nonnegative(),
    reasoning: zod.number().int().nonnegative(),
    llmMs: zod.number().nonnegative(),
    toolMs: zod.number().nonnegative(),
  })
  .strict()
  .nullable();

export function normalizeConfig(raw = {}) {
  const currency = typeof raw.currency === "string" && raw.currency.trim() ? raw.currency.trim().toUpperCase() : "USD";
  const detail = Number(raw.detailTurns);
  return {
    showCosts: raw.showCosts !== false,
    currency,
    offPeak: raw.offPeak === true,
    detailTurns: Number.isFinite(detail) && detail >= 10 ? Math.min(1000, Math.floor(detail)) : DEFAULT_DETAIL_TURNS,
    language: raw.language === "zh" ? "zh" : "en",
    prices: normalizePrices(raw.prices),
  };
}

const TOOL_DESCRIPTION =
  "Read the session's cost/performance profile: token totals, per-model breakdown, " +
  "per-turn latency attribution and the slowest tools. Use it when the user asks about " +
  "token usage, cost, spending, latency or performance of the current session.";

function sessionOf(agent) {
  return agent?.session ?? agent ?? null;
}

function registerCostCommand(ctx, reportFor, historyReport, tr) {
  const definition = (name_) => ({
    name: name_,
    description: tr("commandDescription"),
    input: { hint: "[summary|full|json] or [week|month|all] [summary|json]" },
    handler: (invocation) => {
      const parsed = parseMode(invocation.rawInput);
      if (parsed === null) {
        return { kind: "error", text: tr("unknownArg", { arg: invocation.rawInput.trim(), usage: tr("usage") }) };
      }
      // Cross-session rollups read locally stored sessions, so they work even
      // where the live projection does not exist yet.
      if (parsed.scope !== null) {
        return { kind: "success", text: historyReport(parsed.scope, parsed.format) };
      }
      const session = sessionOf(invocation.agent);
      if (!session) return { kind: "error", text: tr("noSession") };
      return { kind: "success", text: reportFor(session, parsed.format) };
    },
  });
  try {
    ctx.commands.register(definition("cost"));
  } catch {
    // Name collision with an existing /cost — fall back to an unambiguous name.
    ctx.commands.register(definition("cost-report"));
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);

  ctx.sessionProjections.register({
    key: "costProfiler",
    stateSchema,
    stateVersion: STATE_VERSION,
    init: () => null,
    apply: (state, event) => applyEvent(state, event, { detailTurns: cfg.detailTurns }),
    wire: { viewSchema: wireSchema, view: wireView },
  });

  const reportFor = (session, mode) => renderReport(ctx.sessionProjections.stateOf(session, "costProfiler"), cfg, mode);
  const historyReport = (scope, format) =>
    renderSessionsReport(collectSessions({ days: SCOPE_DAYS[scope] ?? null }), cfg, scope, format);

  registerCostCommand(ctx, reportFor, historyReport, tFor(cfg.language));

  ctx.tools.register(
    defineTool({
      name: "cost_report",
      description: TOOL_DESCRIPTION,
      parameters: {
        detail: {
          type: "string",
          enum: MODES,
          description: "Report granularity: summary (default), full (per-turn table), or json.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { report: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.report }],
      },
      async execute(args, exec) {
        const session = sessionOf(exec.agent);
        if (!session) {
          return { report: "cost_report is unavailable here: this tool call has no owning agent session." };
        }
        const mode = MODES.includes(args?.detail) ? args.detail : "summary";
        return { report: reportFor(session, mode) };
      },
    }),
  );
}

export { name, inject, Config };
