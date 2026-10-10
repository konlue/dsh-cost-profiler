/**
 * Unit tests for the pure fold + report layers. Runs with plain
 * `node --test` — no DSH host needed; the plugin entry (lib/index.js) is
 * exercised by the host integration in the desktop profile.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, tokenTotals, wireView, STATE_VERSION } from "../lib/fold.js";
import { renderReport, parseMode, USAGE, fmtTokens, fmtMs, fmtCost } from "../lib/report.js";
import { resolvePrice, routeCost, normalizePrices } from "../lib/prices.js";

const ev = (type, data, time) => ({ type, data, time });
const fold = (events, opts) => events.reduce((state, e) => applyEvent(state, e, opts), null);
const firstLine = (text) => text.split("\n", 1)[0];

const FLASH = { provider: "deepseek", model: "deepseek-flash" };
const PRO = { provider: "deepseek", model: "deepseek-v4-pro" };

/** A full two-turn synthetic session exercising every folded event type. */
function twoTurnEvents() {
  return [
    ev("turn/start", { turn: 1 }, 0),
    ev("step/start", { turn: 1, step: 0 }, 100),
    ev("tool/call", { turn: 1, step: 0, callId: "c1", name: "read_file", arguments: {} }, 200),
    ev("tool/result", { turn: 1, step: 0, message: { source: { callId: "c1" }, content: [{ isError: false }] } }, 1700),
    ev("assistant/message", { turn: 1, step: 0, message: { source: FLASH }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, reasoningTokens: 100 } }, 5000),
    ev("step/end", { turn: 1, step: 0 }, 5100),
    ev("turn/end", { turn: 1, reason: { kind: "end-turn" } }, 5200),
    ev("turn/start", { turn: 2 }, 6000),
    ev("assistant/message", { turn: 2, step: 0, message: { source: PRO }, usage: { inputTokens: 2000, outputTokens: 300 } }, 8000),
    ev("turn/end", { turn: 2, reason: { kind: "end-turn" } }, 8200),
  ];
}

test("irrelevant events return the identical state reference", () => {
  const state = fold(twoTurnEvents());
  const after = applyEvent(state, ev("command/run", { command: "cost" }, 9000));
  const afterUnknown = applyEvent(state, ev("totally/unknown", {}, 9001));
  assert.equal(after, state);
  assert.equal(afterUnknown, state);
  assert.equal(applyEvent(null, ev("step/end", { turn: 1, step: 0 }, 1)), null);
});

test("two-turn session aggregates tokens, routes, tools and wall time", () => {
  const s = fold(twoTurnEvents());
  assert.equal(STATE_VERSION, 1);
  assert.equal(s.totals.turns, 2);
  assert.equal(s.totals.msgs, 2);
  assert.equal(s.totals.toolMs, 1500);
  assert.equal(s.totals.llmMs, 3500);
  assert.equal(s.totals.wallMs, 7400);

  const t = tokenTotals(s.totals.routes);
  assert.equal(t.input, 3000);
  assert.equal(t.output, 800);
  assert.equal(t.cacheRead, 2000);
  assert.equal(t.reasoning, 100);
  assert.equal(t.msgs, 2);

  const flash = s.totals.routes["deepseek/deepseek-flash"];
  const pro = s.totals.routes["deepseek/deepseek-v4-pro"];
  assert.deepEqual(
    { input: flash.input, output: flash.output, cacheRead: flash.cacheRead, msgs: flash.msgs },
    { input: 1000, output: 500, cacheRead: 2000, msgs: 1 },
  );
  assert.deepEqual({ input: pro.input, output: pro.output, msgs: pro.msgs }, { input: 2000, output: 300, msgs: 1 });

  const tool = s.totals.tools.read_file;
  assert.equal(tool.count, 1);
  assert.equal(tool.ms, 1500);
  assert.equal(tool.max, 1500);
  assert.equal(tool.errs, 0);

  assert.equal(s.turns.length, 2);
  const [turn1, turn2] = s.turns;
  assert.equal(turn1.wallMs, 5200);
  assert.equal(turn1.llmMs, 3500);
  assert.equal(turn1.toolMs, 1500);
  assert.equal(turn1.steps, 1);
  assert.equal(turn2.wallMs, 2200);
  assert.equal(turn2.llmMs, 0);
});

test("later usage for the same (turn, step) replaces instead of accumulating", () => {
  const s = fold([
    ev("turn/start", { turn: 1 }, 0),
    ev("assistant/message", { turn: 1, step: 0, message: { source: FLASH }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 } }, 100),
    ev("assistant/message", { turn: 1, step: 0, message: { source: FLASH }, usage: { inputTokens: 1200, outputTokens: 600, cacheReadTokens: 2400 } }, 200),
    ev("turn/end", { turn: 1 }, 300),
  ]);
  const flash = s.totals.routes["deepseek/deepseek-flash"];
  assert.deepEqual(
    { input: flash.input, output: flash.output, cacheRead: flash.cacheRead, msgs: flash.msgs },
    { input: 1200, output: 600, cacheRead: 2400, msgs: 1 },
  );
  assert.equal(tokenTotals(s.totals.routes).input, 1200);
});

test("retries are counted once per llm/retry-started", () => {
  const s = fold([
    ev("turn/start", { turn: 1 }, 0),
    ev("llm/retry", { turn: 1 }, 100),
    ev("assistant/message", { turn: 1, step: 0, message: { source: FLASH }, usage: { inputTokens: 10, outputTokens: 5 } }, 200),
    ev("turn/end", { turn: 1 }, 300),
  ]);
  assert.equal(s.totals.retries, 0);
  const s2 = fold([
    ev("turn/start", { turn: 1 }, 0),
    ev("llm/retry-started", { turn: 1 }, 100),
    ev("assistant/message", { turn: 1, step: 0, message: { source: FLASH }, usage: { inputTokens: 10, outputTokens: 5 } }, 200),
    ev("turn/end", { turn: 1 }, 300),
  ]);
  assert.equal(s2.totals.retries, 1);
});

test("failed tool results increment the error count; orphan results count under 'unknown'", () => {
  const s = fold([
    ev("turn/start", { turn: 1 }, 0),
    ev("tool/call", { turn: 1, step: 0, callId: "c1", name: "bash" }, 100),
    ev("tool/result", { turn: 1, step: 0, message: { source: { callId: "c1" }, content: [{ isError: true }] }, error: { code: "exit" } }, 2100),
    ev("tool/result", { turn: 1, step: 0, message: { source: { callId: "ghost" }, content: [] } }, 2500),
    ev("turn/end", { turn: 1 }, 3000),
  ]);
  assert.deepEqual(s.totals.tools.bash, { count: 1, ms: 2000, max: 2000, unknown: 0, errs: 1 });
  assert.deepEqual(s.totals.tools.unknown, { count: 1, ms: 0, max: 0, unknown: 1, errs: 0 });
  assert.equal(s.totals.toolMs, 2000);
});

test("per-turn detail is trimmed to detailTurns while totals stay whole-session", () => {
  const events = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    events.push(
      ev("turn/start", { turn }, turn * 1000),
      ev("assistant/message", { turn, step: 0, message: { source: FLASH }, usage: { inputTokens: 100, outputTokens: 10 } }, turn * 1000 + 500),
      ev("turn/end", { turn }, turn * 1000 + 900),
    );
  }
  const s = fold(events, { detailTurns: 2 });
  assert.equal(s.turns.length, 2);
  assert.deepEqual(s.turns.map((t) => t.turn), [2, 3]);
  assert.equal(s.totals.turns, 3);
  assert.equal(tokenTotals(s.totals.routes).input, 300);
});

test("state is plain-JSON serializable and fold is deterministic across a checkpoint round-trip", () => {
  const s = fold(twoTurnEvents());
  const restored = JSON.parse(JSON.stringify(s));
  assert.deepEqual(restored, s);
  const extra = [ev("turn/start", { turn: 3 }, 10_000), ev("turn/end", { turn: 3 }, 11_000)];
  assert.deepEqual(foldFrom(s, extra), foldFrom(restored, extra));
});

function foldFrom(state, events) {
  return events.reduce((acc, e) => applyEvent(acc, e, {}), state);
}

test("wireView exposes the compact aggregates", () => {
  assert.equal(wireView(null), null);
  const view = wireView(fold(twoTurnEvents()));
  assert.deepEqual(view, {
    turns: 2,
    msgs: 2,
    retries: 0,
    input: 3000,
    output: 800,
    cacheRead: 2000,
    cacheWrite: 0,
    reasoning: 100,
    llmMs: 3500,
    toolMs: 1500,
  });
});

test("price resolution: route key, bare model, user override, default catch-all", () => {
  assert.deepEqual(resolvePrice("deepseek/deepseek-flash", {}, false), { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  assert.deepEqual(resolvePrice("deepseek/deepseek-v4-pro", {}, true).input, 0.66);
  assert.equal(resolvePrice("acme/unknown-model", {}, false), null);
  const overrides = normalizePrices({ "acme/unknown-model": { input: 1, output: 2 }, default: { input: 0.5, output: 1 } });
  assert.deepEqual(resolvePrice("acme/unknown-model", overrides, false), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(resolvePrice("acme/other", overrides, false).input, 0.5);
  assert.equal(normalizePrices({ bad: "junk", ok: { input: -1, output: "3" } }).ok.output, 0);
});

test("route cost matches hand-computed DeepSeek flash pricing", () => {
  const price = resolvePrice("deepseek/deepseek-flash", {}, false);
  const bucket = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 };
  // 1000*0.30 + 2000*0.006 + 500*1.20 = 300 + 12 + 600 = 912 micro-units
  assert.ok(Math.abs(routeCost(bucket, price) - 0.000912) < 1e-12);
});

test("formatters produce compact, human-readable values", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(2000), "2k");
  assert.equal(fmtTokens(2500), "2.5k");
  assert.equal(fmtTokens(128_400), "128.4k");
  assert.equal(fmtTokens(1_284_000), "1.28M");
  assert.equal(fmtMs(0), "0ms");
  assert.equal(fmtMs(850), "850ms");
  assert.equal(fmtMs(1500), "1.5s");
  assert.equal(fmtMs(62_000), "1m02s");
  assert.equal(fmtMs(3_720_000), "1h02m");
  assert.equal(fmtCost(0.000912, "$"), "$0.0009");
  assert.equal(fmtCost(0.53, "$"), "$0.53");
  assert.equal(fmtCost(0, "$"), "$0.00");
});

test("summary report contains totals, model table, tools and cost note", () => {
  const cfg = { showCosts: true, currency: "USD", offPeak: false, prices: {} };
  const text = renderReport(fold(twoTurnEvents()), cfg, "summary");
  assert.match(text, /^Session cost \$0\.0047 \(est\) · 2 turns · 3k in · 800 out · 40% cache hit · 7\.4s wall$/m);
  assert.match(text, /\*\*Turns\*\* 2 · \*\*Messages\*\* 2/);
  assert.match(text, /\| `deepseek\/deepseek-flash` \|/);
  assert.match(text, /\| `read_file` \| 1 \| 1\.5s \| 1\.5s \| 0 \|/);
  assert.match(text, /Estimated cost\*\* \$0\.0047/);
  assert.match(text, /API list-price estimates/);
});

test("report line 1 is self-contained prose usable as a collapsed card label", () => {
  const cfg = { showCosts: true, currency: "USD", offPeak: false, prices: {} };
  const state = fold(twoTurnEvents());
  for (const mode of ["summary", "full"]) {
    const line = firstLine(renderReport(state, cfg, mode));
    assert.match(line, /^Session cost \$0\.0047 \(est\) · 2 turns · 3k in · 800 out · 40% cache hit · 7\.4s wall$/);
    assert.doesNotMatch(line, /[#|`]/);
    assert.doesNotMatch(line, /\*\*/);
  }

  const noCost = firstLine(renderReport(state, { ...cfg, showCosts: false }, "summary"));
  assert.match(noCost, /^Session cost: tracking off · 2 turns · /);
  assert.doesNotMatch(noCost, /[#|`]/);

  const empty = renderReport(null, cfg, "summary");
  assert.equal(empty.split("\n").length, 1);
  assert.match(empty, /^Session cost: nothing profiled in this session yet/);
  assert.doesNotMatch(firstLine(empty), /[#|`]/);
});

test("summary hides cost columns when showCosts is false", () => {
  const cfg = { showCosts: false, currency: "USD", offPeak: false, prices: {} };
  const text = renderReport(fold(twoTurnEvents()), cfg, "summary");
  assert.doesNotMatch(text, /\$/);
  assert.doesNotMatch(text, /Est\. cost/);
  assert.match(text, /Tokens\*\* 3k in/);
});

test("unpriced models get an em-dash and a hint instead of a wrong estimate", () => {
  const cfg = { showCosts: true, currency: "USD", offPeak: false, prices: {} };
  const s = fold([
    ev("turn/start", { turn: 1 }, 0),
    ev("assistant/message", { turn: 1, step: 0, message: { source: { provider: "acme", model: "mystery" } }, usage: { inputTokens: 10, outputTokens: 5 } }, 100),
    ev("turn/end", { turn: 1 }, 200),
  ]);
  const text = renderReport(s, cfg, "summary");
  assert.match(text, /`acme\/mystery` .*\| — \|/);
  assert.match(text, /No price configured for/);
});

test("full report adds the per-turn table; json report round-trips", () => {
  const cfg = { showCosts: true, currency: "USD", offPeak: false, prices: {} };
  const state = fold(twoTurnEvents());
  const full = renderReport(state, cfg, "full");
  assert.match(full, /\*\*Turns\*\* \(last 2 of 2 kept\)/);
  assert.match(full, /\| 1 \| 5\.2s \|/);

  const json = renderReport(state, cfg, "json");
  const parsed = JSON.parse(json);
  assert.equal(parsed.totals.turns, 2);
  assert.equal(parsed.totals.tokens.input, 3000);
  assert.equal(parsed.cost.estimate > 0, true);
  assert.equal(parsed.cost.currency, "USD");
  assert.ok(Array.isArray(parsed.turns));

  const noCost = JSON.parse(renderReport(state, { ...cfg, showCosts: false }, "json"));
  assert.equal(noCost.cost, undefined);
});

test("empty sessions render a friendly hint, not a broken table", () => {
  const cfg = { showCosts: true, currency: "USD", offPeak: false, prices: {} };
  const summary = renderReport(null, cfg, "summary");
  assert.match(summary, /nothing profiled in this session yet/);
  const json = JSON.parse(renderReport(null, cfg, "json"));
  assert.equal(json.status, "empty");
  const emptyState = fold([ev("command/run", {}, 0)]);
  assert.match(renderReport(emptyState, cfg, "summary"), /nothing profiled in this session yet/);
});

test("parseMode accepts the documented vocabulary", () => {
  assert.deepEqual(parseMode(""), { scope: null, format: "summary" });
  assert.deepEqual(parseMode("  "), { scope: null, format: "summary" });
  assert.deepEqual(parseMode("full"), { scope: null, format: "full" });
  assert.deepEqual(parseMode(" JSON "), { scope: null, format: "json" });
  assert.equal(parseMode("verbose"), null);
  assert.match(USAGE, /\/cost/);
});
