/**
 * Pure fold over the durable session event stream for the cost profiler
 * projection. Events are the DeepSeek Harness session-log envelope
 * `{ type, data, time, seq }` as appended by `@deepseek-ai/dsh-agent-loop`:
 *
 *   turn/start        { turn }
 *   turn/end          { turn, reason }
 *   step/start        { turn, step }
 *   step/end          { turn, step }
 *   assistant/message { turn, step, message: { source: { provider, model } }, usage? }
 *   tool/call         { turn, step, callId, name, arguments }
 *   tool/result       { turn, step, message, error? }
 *
 * Usage semantics mirror the official token-usage projection
 * (`@deepseek-ai/dsh-token-meter`): token counts come from the authoritative
 * `assistant/message` settlement only — streamed attempt samples and aborted
 * retries never enter the fold, and a later usage for the same (turn, step)
 * replaces the earlier one. Tool durations are the `tool/call` → `tool/result`
 * envelope-time delta, paired by `callId`.
 *
 * Every handler is synchronous and copy-on-write: irrelevant events return
 * the previous state reference unchanged (the projection registry relies on
 * `Object.is` to skip view recomputation), and changed states are fresh
 * plain-JSON objects so projection checkpoints can persist them as-is.
 *
 * @module dsh-cost-profiler/fold
 */

/** Bump when the fold semantics or state shape change incompatibly. */
export const STATE_VERSION = 1;

/** Default cap on remembered per-turn detail rows (configurable). */
export const DEFAULT_DETAIL_TURNS = 100;

/** Hard cap on distinct tool names tracked per state (defensive bound). */
const MAX_TOOLS = 500;

/** Hard cap on open tool-call entries held between call and result. */
const MAX_PENDING = 200;

/**
 * Empty fold state. `init` returns `null` instead so that sessions with no
 * profiled activity stay a compact `null` cell; handlers promote `null` via
 * {@link emptyState} on first relevant event.
 */
export function emptyState() {
  return {
    /** Per-turn detail, oldest last, trimmed to `detailTurns`. */
    turns: [],
    /** Open tool calls: callId → { name, t0 }. */
    pending: {},
    /** Currently open step: { turn, step, t0, toolMs }, or null. */
    step: null,
    /** Last settled assistant usage, for (turn, step) replacement. */
    lastMsg: null,
    /** Whole-session aggregates, never trimmed. */
    totals: { turns: 0, msgs: 0, retries: 0, llmMs: 0, toolMs: 0, wallMs: 0, routes: {}, tools: {} },
  };
}

const ensureState = (state) => state ?? emptyState();

const routeKeyOf = (source) => `${source?.provider ?? "unknown"}/${source?.model ?? "unknown"}`;

const normUsage = (usage) => ({
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  cacheReadTokens: usage?.cacheReadTokens ?? 0,
  cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  reasoningTokens: usage?.reasoningTokens ?? 0,
});

const zeroRoute = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0 });

const newTurn = (turn, t0, closed) => ({
  turn: turn ?? 0,
  t0: t0 ?? 0,
  ...(closed ? { t1: t0 ?? 0, wallMs: 0 } : { t1: null, wallMs: null }),
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  routes: {},
  tools: {},
});

/** Index of the last bucket with this turn number, or -1. */
function findBucketIndex(state, turn) {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    if (state.turns[i].turn === turn) return i;
  }
  return -1;
}

/** Ensure a bucket for `turn` exists (created as a closed orphan when the
 * turn/start event is not part of the retained log); returns { state, idx }. */
function ensureBucket(state, turn, t0, cap) {
  const idx = findBucketIndex(state, turn);
  if (idx >= 0) return { state, idx };
  let turns = [...state.turns, newTurn(turn, t0, true)];
  if (turns.length > cap) turns = turns.slice(turns.length - cap);
  return { state: { ...state, turns }, idx: turns.length - 1 };
}

function addRoute(buckets, key, usage, msgs = 0) {
  const prev = buckets[key];
  const next = prev ? { ...prev } : zeroRoute();
  next.input += usage.inputTokens;
  next.output += usage.outputTokens;
  next.cacheRead += usage.cacheReadTokens;
  next.cacheWrite += usage.cacheWriteTokens;
  next.reasoning += usage.reasoningTokens;
  next.msgs += msgs;
  buckets[key] = next;
}

function subRoute(buckets, key, usage) {
  const prev = buckets[key];
  if (!prev) return;
  buckets[key] = {
    ...prev,
    input: Math.max(0, prev.input - usage.inputTokens),
    output: Math.max(0, prev.output - usage.outputTokens),
    cacheRead: Math.max(0, prev.cacheRead - usage.cacheReadTokens),
    cacheWrite: Math.max(0, prev.cacheWrite - usage.cacheWriteTokens),
    reasoning: Math.max(0, prev.reasoning - usage.reasoningTokens),
  };
}

function aggTool(prev, dur, isError) {
  return {
    count: (prev?.count ?? 0) + 1,
    ms: (prev?.ms ?? 0) + (dur ?? 0),
    max: Math.max(prev?.max ?? 0, dur ?? 0),
    unknown: (prev?.unknown ?? 0) + (dur === null ? 1 : 0),
    errs: (prev?.errs ?? 0) + (isError ? 1 : 0),
  };
}

function onTurnStart(state, event, cap) {
  const s = ensureState(state);
  const turn = event.data?.turn;
  const last = s.turns[s.turns.length - 1];
  if (last && last.t1 === null && last.turn === turn) return state;
  let turns = [...s.turns, newTurn(turn, event.time)];
  if (turns.length > cap) turns = turns.slice(turns.length - cap);
  return { ...s, turns };
}

function onTurnEnd(state, event) {
  const s = ensureState(state);
  const idx = findBucketIndex(s, event.data?.turn);
  if (idx < 0) return s;
  const bucket = s.turns[idx];
  if (bucket.t1 !== null) return s;
  const t1 = event.time ?? bucket.t0;
  const turns = s.turns.slice();
  turns[idx] = { ...bucket, t1, wallMs: Math.max(0, t1 - bucket.t0) };
  return {
    ...s,
    turns,
    totals: {
      ...s.totals,
      turns: s.totals.turns + 1,
      wallMs: s.totals.wallMs + Math.max(0, t1 - bucket.t0),
    },
  };
}

function onStepStart(state, event) {
  const s = ensureState(state);
  const { turn, step } = event.data ?? {};
  const idx = findBucketIndex(s, turn);
  let turns = s.turns;
  if (idx >= 0 && turns[idx].t1 === null) {
    turns = s.turns.slice();
    turns[idx] = { ...turns[idx], steps: turns[idx].steps + 1 };
  }
  return { ...s, turns, step: { turn: turn ?? 0, step: step ?? 0, t0: event.time ?? 0, toolMs: 0 } };
}

function onStepEnd(state, event) {
  const s = ensureState(state);
  const step = s.step;
  if (!step) return state;
  const wall = Math.max(0, (event.time ?? step.t0) - step.t0);
  const llm = Math.max(0, wall - step.toolMs);
  const idx = findBucketIndex(s, step.turn);
  let turns = s.turns;
  if (idx >= 0 && turns[idx].t1 === null) {
    turns = s.turns.slice();
    turns[idx] = { ...turns[idx], llmMs: turns[idx].llmMs + llm };
  }
  return { ...s, turns, step: null, totals: { ...s.totals, llmMs: s.totals.llmMs + llm } };
}

function onAssistantMessage(state, event, cap) {
  const s = ensureState(state);
  const data = event.data ?? {};
  const source = data.message?.source;
  if (data.usage === undefined && source === undefined) return state;
  const usage = normUsage(data.usage);
  const key = routeKeyOf(source);
  const turn = data.turn ?? 0;
  const step = data.step ?? 0;
  const replacing = s.lastMsg !== null && s.lastMsg.turn === turn && s.lastMsg.step === step;

  const ensured = ensureBucket(s, turn, event.time, cap);
  const bucket = ensured.state.turns[ensured.idx];

  const routes = { ...bucket.routes };
  if (replacing) subRoute(routes, s.lastMsg.route, s.lastMsg.usage);
  addRoute(routes, key, usage, replacing ? 0 : 1);
  const turns = ensured.state.turns.slice();
  turns[ensured.idx] = { ...bucket, routes };

  const totalsRoutes = { ...ensured.state.totals.routes };
  if (replacing) subRoute(totalsRoutes, s.lastMsg.route, s.lastMsg.usage);
  addRoute(totalsRoutes, key, usage, replacing ? 0 : 1);
  const totals = {
    ...ensured.state.totals,
    routes: totalsRoutes,
    msgs: ensured.state.totals.msgs + (replacing ? 0 : 1),
  };

  return { ...ensured.state, turns, totals, lastMsg: { turn, step, route: key, usage } };
}

function onToolCall(state, event, cap) {
  const s = ensureState(state);
  const data = event.data ?? {};
  if (data.callId === undefined) return state;
  const pending = { ...s.pending, [data.callId]: { name: data.name ?? "unknown", t0: event.time ?? 0 } };
  const callIds = Object.keys(pending);
  if (callIds.length > MAX_PENDING) {
    for (const id of callIds.slice(0, callIds.length - MAX_PENDING)) delete pending[id];
  }
  const ensured = ensureBucket(s, data.turn ?? 0, event.time, cap);
  return { ...ensured.state, pending };
}

function onToolResult(state, event, cap) {
  const s = ensureState(state);
  const data = event.data ?? {};
  const callId = data.message?.source?.callId ?? data.callId;
  const open = callId !== undefined ? s.pending[callId] : undefined;
  const name = open?.name ?? data.message?.source?.name ?? "unknown";
  const dur = open ? Math.max(0, (event.time ?? open.t0) - open.t0) : null;
  const content = data.message?.content;
  const isError =
    data.error !== undefined || (Array.isArray(content) && content.some((block) => block?.isError === true));

  const pending = { ...s.pending };
  if (callId !== undefined) delete pending[callId];

  const step = s.step === null ? null : { ...s.step, toolMs: s.step.toolMs + (dur ?? 0) };

  const tools = { ...s.totals.tools };
  tools[name] = aggTool(tools[name], dur, isError);

  const ensured = ensureBucket(s, data.turn ?? 0, event.time, cap);
  const bucket = ensured.state.turns[ensured.idx];
  const bucketTools = { ...bucket.tools };
  bucketTools[name] = aggTool(bucketTools[name], dur, isError);
  const turns = ensured.state.turns.slice();
  turns[ensured.idx] = { ...bucket, toolMs: bucket.toolMs + (dur ?? 0), tools: bucketTools };

  return {
    ...ensured.state,
    turns,
    pending,
    step,
    totals: {
      ...ensured.state.totals,
      toolMs: ensured.state.totals.toolMs + (dur ?? 0),
      tools: Object.keys(tools).length > MAX_TOOLS ? trimTools(tools) : tools,
    },
  };
}

/** Keep only the busiest tool names when the defensive cap is exceeded. */
function trimTools(tools) {
  return Object.fromEntries(
    Object.entries(tools).sort(([, a], [, b]) => b.count - a.count).slice(0, MAX_TOOLS),
  );
}

function onRetry(state) {
  const s = ensureState(state);
  return { ...s, totals: { ...s.totals, retries: s.totals.retries + 1 } };
}

/**
 * Fold one committed session event into the projection state.
 * @param state previous state (may be `null`)
 * @param event session-log envelope `{ type, data, time, seq }`
 * @param opts `{ detailTurns }` — per-turn detail cap (default 100)
 * @returns the next state; identical reference when the event is irrelevant
 */
export function applyEvent(state, event, opts = {}) {
  const cap = Math.max(1, Math.floor(opts.detailTurns ?? DEFAULT_DETAIL_TURNS));
  switch (event?.type) {
    case "turn/start": return onTurnStart(state, event, cap);
    case "turn/end": return onTurnEnd(state, event);
    case "step/start": return onStepStart(state, event);
    case "step/end": return onStepEnd(state, event);
    case "assistant/message": return onAssistantMessage(state, event, cap);
    case "tool/call": return onToolCall(state, event, cap);
    case "tool/result": return onToolResult(state, event, cap);
    case "llm/retry-started": return onRetry(state);
    default: return state ?? null;
  }
}

/** Sum route buckets into session token totals. */
export function tokenTotals(routes) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0 };
  for (const bucket of Object.values(routes ?? {})) {
    totals.input += bucket.input;
    totals.output += bucket.output;
    totals.cacheRead += bucket.cacheRead;
    totals.cacheWrite += bucket.cacheWrite;
    totals.reasoning += bucket.reasoning;
    totals.msgs += bucket.msgs;
  }
  return totals;
}

/** Compact client-facing view (wire projection of the durable aggregates). */
export function wireView(state) {
  if (!state) return null;
  const tokens = tokenTotals(state.totals.routes);
  return {
    turns: state.totals.turns,
    msgs: state.totals.msgs,
    retries: state.totals.retries,
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: tokens.reasoning,
    llmMs: state.totals.llmMs,
    toolMs: state.totals.toolMs,
  };
}
