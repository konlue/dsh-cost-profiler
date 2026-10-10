/**
 * Tests for the cross-session history layer (lib/history.js) and the
 * sessions report (lib/report.js). Fixtures write real multi-frame zstd
 * session logs and projcache checkpoints into a temp DSH home, so the scan
 * path exercised here is the one the plugin runs against `~/.dsh`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { collectSessions, aggregateSessions, decodeSessionLog, SCOPES, SCOPE_DAYS } from "../lib/history.js";
import { renderSessionsReport, parseMode } from "../lib/report.js";

const FLASH_PRICE = { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 };
const CFG = { showCosts: true, currency: "USD", offPeak: false, prices: {} };

const NOW = Date.now();
const DAY = 86_400_000;

const ev = (type, data, time) => ({ type, data, time });

/** Build a fake DSH home with one workspace-slug dir per session. */
function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cost-hist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Write one session: log frames (multi-frame zstd) and optional projcache. */
function writeSession(root, { slug, id, events, header, frames, projcache, logSuffix, mtime }) {
  const dir = path.join(root, "sessions", slug ?? "--D-code-Zcode-dsh--", id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify(header ?? { type: "session", version: 4, id, createdAt: 0, cwd: "D:\\code\\Zcode\\dsh", isSeeded: false }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  const groups = frames ?? [lines];
  const buffers = groups.map((group) => zlib.zstdCompressSync(Buffer.from(group.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"), "utf8")));
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(buffers), logSuffix === "torn" ? { flag: "a" } : undefined);
  const logPath = path.join(dir, "session.v4.jsonl.zstd");
  if (logSuffix === "torn") fs.appendFileSync(logPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x00, 0xff]));
  if (mtime !== undefined) fs.utimesSync(logPath, new Date(mtime), new Date(mtime));
  if (projcache !== undefined) {
    const projDir = path.join(root, "storages", "session_projcache", "sessions");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${id}.json`), JSON.stringify(projcache));
  }
  return dir;
}

const defaultHeader = (id, cwd) => ({ type: "session", version: 4, id, createdAt: NOW - 3 * DAY, cwd, isSeeded: false });

/** Two turns on one route (each with turn/start, as real logs always have) + one timed tool call. */
function usageEvents(t0) {
  return [
    ev("turn/start", { turn: 1 }, t0),
    ev("tool/call", { turn: 1, step: 0, callId: "c1", name: "bash", arguments: {} }, t0 + 10),
    ev("tool/result", { turn: 1, step: 0, message: { source: { callId: "c1" }, content: [{}] } }, t0 + 1010),
    ev("assistant/message", { turn: 1, step: 0, message: { source: { provider: "deepseek-account", model: "deepseek-flash" } }, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 0, reasoningTokens: 50 } }, t0 + 2000),
    ev("turn/end", { turn: 1 }, t0 + 2500),
    ev("turn/start", { turn: 2 }, t0 + DAY),
    ev("assistant/message", { turn: 2, step: 0, message: { source: { provider: "deepseek-account", model: "deepseek-flash" } }, usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 } }, t0 + DAY + 2000),
    ev("turn/end", { turn: 2 }, t0 + DAY + 2500),
  ];
}

const profilerState = (routes, totals) => ({
  turns: [],
  pending: {},
  step: null,
  lastMsg: null,
  totals: { turns: totals.turns, msgs: totals.msgs, retries: 0, llmMs: totals.llmMs, toolMs: totals.toolMs, wallMs: totals.wallMs, routes, tools: {} },
});

function projcacheRows(rows, cwd = "D:\\code\\Zcode\\dsh") {
  return { version: 7, record: { identity: { formatVersion: 4, createdAt: NOW - 3 * DAY, cwd, isSeeded: false, inheritedEventCount: 0 }, rows } };
}

test("collectSessions prefers the profiler checkpoint and keeps per-route buckets", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-aaa",
    header: defaultHeader("session-aaa", "D:\\work\\project-a"),
    events: [],
    projcache: projcacheRows(
      {
        title: { ver: 1, seq: 2, val: "Fix the login bug" },
        sessionListMetadata: { ver: 1, seq: 3, val: { blank: false, lastPromptAt: NOW - DAY } },
        sessionStats: { ver: 1, seq: 4, val: { turns: 2, llmMs: 900, toolMs: 100 } },
        costProfiler: { ver: 1, seq: 5, val: profilerState({ "deepseek/deepseek-v4-pro": { input: 2000, output: 300, cacheRead: 500, cacheWrite: 0, reasoning: 10, msgs: 2 } }, { turns: 2, msgs: 2, llmMs: 900, toolMs: 100, wallMs: 4000 }) },
      },
      "D:\\work\\project-a",
    ),
  });

  const { records, errors } = collectSessions({ root, now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, "profiler");
  assert.equal(record.title, "Fix the login bug");
  assert.equal(record.workspaceName, "project-a");
  assert.equal(record.lastPromptAt, NOW - DAY);
  assert.deepEqual(record.routes["deepseek/deepseek-v4-pro"], { input: 2000, output: 300, cacheRead: 500, cacheWrite: 0, reasoning: 10, msgs: 2 });
  assert.deepEqual(record.usage, { turns: 2, llmMs: 900, toolMs: 100 });
});

test("official tokenUsage checkpoint is the fallback and prices via the last-used model", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-bbb",
    header: defaultHeader("session-bbb", "D:\\work\\project-b"),
    events: [],
    projcache: projcacheRows({
      title: { ver: 1, seq: 2, val: "Official totals only" },
      sessionStats: { ver: 1, seq: 3, val: { turns: 1, llmMs: 500, toolMs: 0 } },
      tokenUsage: { ver: 2, seq: 4, val: { totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 0 } } },
      modelSelection: { ver: 1, seq: 5, val: { lastUsed: { provider: "deepseek-account", model: "deepseek-flash" } } },
    }),
  });

  const { records } = collectSessions({ root, now: NOW });
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, "official");
  // Priced through the bare-model fallback: deepseek-account/deepseek-flash.
  assert.deepEqual(record.routes["deepseek-account/deepseek-flash"], { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0, reasoning: 0, msgs: 0 });

  const agg = aggregateSessions(records, CFG);
  const expected = ((1000 * 0.3 + 4000 * 0.006 + 200 * 1.2) / 1_000_000).toFixed(7);
  assert.equal(agg.sessions[0].cost.toFixed(7), expected);
  assert.equal(agg.totals.estimate.toFixed(7), expected);
});

test("sessions without a checkpoint are replayed from the log", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-ccc",
    header: defaultHeader("session-ccc", "D:\\work\\project-c"),
    events: usageEvents(NOW - 2 * DAY),
  });

  const { records, errors } = collectSessions({ root, now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, "replay");
  assert.equal(record.id, "session-ccc");
  assert.equal(record.cwd, "D:\\work\\project-c");
  assert.equal(record.usage.turns, 2);
  const flash = record.routes["deepseek-account/deepseek-flash"];
  assert.deepEqual({ input: flash.input, output: flash.output, msgs: flash.msgs }, { input: 1500, output: 300, msgs: 2 });
  // Tool timing came through the replay too.
  assert.equal(record.usage.toolMs, 1000);
});

test("a torn trailing frame is skipped without losing the session", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-torn",
    header: defaultHeader("session-torn", "D:\\work\\project-t"),
    events: usageEvents(NOW - DAY),
    logSuffix: "torn",
  });

  const { records, errors } = collectSessions({ root, now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, "replay");
});

test("decodeSessionLog round-trips multi-frame logs", () => {
  const a = [JSON.stringify({ type: "session", id: "x" }), JSON.stringify(ev("turn/start", { turn: 1 }, 1))];
  const b = [JSON.stringify(ev("turn/end", { turn: 1 }, 2))];
  const buffer = Buffer.concat([zlib.zstdCompressSync(Buffer.from(a.join("\n"))), zlib.zstdCompressSync(Buffer.from(b.join("\n")))]);
  const lines = decodeSessionLog(buffer);
  assert.deepEqual(lines.map((line) => line.type), ["session", "turn/start", "turn/end"]);
});

test("the day window filters by last activity; empty sessions never appear", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-recent",
    header: defaultHeader("session-recent", "D:\\work\\recent"),
    events: usageEvents(NOW - DAY),
  });
  writeSession(root, {
    id: "session-old",
    header: defaultHeader("session-old", "D:\\work\\old"),
    events: usageEvents(NOW - 20 * DAY),
    mtime: NOW - 20 * DAY,
  });
  writeSession(root, {
    id: "session-blank",
    header: defaultHeader("session-blank", "D:\\work\\blank"),
    events: [ev("command/run", { commandId: "x", name: "cost" }, NOW - DAY), ev("turn/start", { turn: 1 }, NOW - DAY)],
  });

  const week = collectSessions({ root, now: NOW, days: SCOPE_DAYS.week });
  assert.deepEqual(week.records.map((r) => r.id), ["session-recent"]);

  const all = collectSessions({ root, now: NOW });
  assert.deepEqual(all.records.map((r) => r.id), ["session-recent", "session-old"]);
});

test("aggregate totals, workspace rollup and the unpriced escape hatch", (t) => {
  const records = [
    {
      id: "a",
      workspaceName: "alpha",
      routes: { "deepseek/deepseek-flash": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 1 } },
      usage: { turns: 1, llmMs: 0, toolMs: 0 },
      activityMs: NOW,
    },
    {
      id: "b",
      workspaceName: "alpha",
      routes: { "acme/mystery": { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 1 } },
      usage: { turns: 1, llmMs: 0, toolMs: 0 },
      activityMs: NOW - 1000,
    },
  ];
  const agg = aggregateSessions(records, CFG);
  assert.equal(agg.totals.sessions, 2);
  assert.equal(agg.totals.tokens.input, 1_000_500);
  // $0.30 per 1M input = $0.30 total; acme/mystery is unpriced.
  assert.equal(agg.totals.estimate.toFixed(7), (0.3).toFixed(7));
  assert.deepEqual(agg.totals.unpriced, ["acme/mystery"]);
  assert.equal(agg.byWorkspace.length, 1);
  assert.equal(agg.byWorkspace[0].workspace, "alpha");
  assert.equal(agg.byWorkspace[0].sessions, 2);
  assert.equal(agg.byWorkspace[0].priced, true);
  // Session sorted by cost: the priced one first despite being newer anyway.
  assert.deepEqual(agg.sessions.map((s) => s.id), ["a", "b"]);
  assert.equal(agg.sessions[1].cost, null);
});

test("the sessions report renders a plain headline, tables and a json variant", (t) => {  const root = makeHome(t);
  writeSession(root, {
    id: "session-aaa",
    header: defaultHeader("session-aaa", "D:\\work\\project-a"),
    events: [],
    projcache: projcacheRows(
      {
        title: { ver: 1, seq: 2, val: "Fix | the | bug" },
        sessionListMetadata: { ver: 1, seq: 3, val: { blank: false, lastPromptAt: NOW - DAY } },
        costProfiler: { ver: 1, seq: 5, val: profilerState({ "deepseek/deepseek-flash": { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0, reasoning: 0, msgs: 3 } }, { turns: 3, msgs: 3, llmMs: 5000, toolMs: 500, wallMs: 9000 }) },
      },
      "D:\\work\\project-a",
    ),
  });
  const collected = collectSessions({ root, now: NOW });

  const text = renderSessionsReport(collected, CFG, "week", "summary");
  const first = text.split("\n", 1)[0];
  // 1M input ($0.30) + 2M cache read ($0.012) + 100k output ($0.12) = $0.432.
  assert.match(first, /^Sessions \$0\.43 \(est\) · 1 session · 3 turns · 1M in · 100k out · 66\.7% cache hit · last 7 days$/);
  assert.doesNotMatch(first, /[#|`]/);
  assert.match(text, /\| `?Fix \\| the \\| bug`? \|/);
  assert.match(text, /\| project-a \| 1 \|/);
  assert.match(text, /never message content/);

  const json = JSON.parse(renderSessionsReport(collected, CFG, "week", "json"));
  assert.equal(json.scope, "week");
  assert.equal(json.sessions.length, 1);
  assert.equal(json.sessions[0].title, "Fix | the | bug");
  assert.equal(json.cost.estimate.toFixed(7), (0.432).toFixed(7));
  assert.equal(json.cost.currency, "USD");

  const noCost = renderSessionsReport(collected, { ...CFG, showCosts: false }, "week", "summary");
  assert.doesNotMatch(noCost, /\$/);
  assert.doesNotMatch(noCost, /Est\. cost/);
  assert.match(noCost.split("\n", 1)[0], /^Sessions: tracking off · 1 session ·/);
});

test("an empty window renders a friendly pointer instead of broken tables", () => {
  const text = renderSessionsReport({ records: [], errors: [] }, CFG, "week", "summary");
  const first = text.split("\n", 1)[0];
  assert.match(first, /^Sessions: nothing profiled last 7 days$/);
  assert.doesNotMatch(first, /[#|`]/);
  assert.match(text, /\/cost all/);
});

test("language: zh renders the sessions report in Chinese; json stays language-stable", (t) => {
  const root = makeHome(t);
  writeSession(root, {
    id: "session-aaa",
    header: defaultHeader("session-aaa", "D:\\work\\project-a"),
    events: [],
    projcache: projcacheRows(
      {
        title: { ver: 1, seq: 2, val: "修复登录 bug" },
        sessionListMetadata: { ver: 1, seq: 3, val: { blank: false, lastPromptAt: NOW - DAY } },
        costProfiler: { ver: 1, seq: 5, val: profilerState({ "deepseek/deepseek-flash": { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0, reasoning: 0, msgs: 3 } }, { turns: 3, msgs: 3, llmMs: 5000, toolMs: 500, wallMs: 9000 }) },
      },
      "D:\\work\\project-a",
    ),
  });
  const collected = collectSessions({ root, now: NOW });
  const zhCfg = { ...CFG, language: "zh" };

  const text = renderSessionsReport(collected, zhCfg, "week", "summary");
  assert.match(
    text.split("\n", 1)[0],
    /^会话汇总 \$0\.43（估算） · 1 个会话 · 3 轮 · 输入 1M · 输出 100k · 缓存命中 66\.7% · 近 7 天$/,
  );
  assert.match(text, /\| 工作区 \| 会话数 \|/);
  assert.match(text, /\| 会话 \| 工作区 \| 最近活跃 \| 轮次 \|/);
  assert.match(text, /仅标题与用量数字/);

  // JSON output keeps English values so script consumers see a stable contract.
  const json = JSON.parse(renderSessionsReport(collected, zhCfg, "week", "json"));
  assert.equal(json.window, "last 7 days");
  assert.equal(json.cost.estimate.toFixed(7), (0.432).toFixed(7));

  const empty = renderSessionsReport({ records: [], errors: [] }, zhCfg, "week", "summary");
  assert.match(empty.split("\n", 1)[0], /^会话汇总：近 7 天没有可统计的活动$/);
  assert.match(empty, /\/cost all/);
});

test("parseMode accepts the scope+format vocabulary and stays backward compatible", () => {
  assert.deepEqual(parseMode(""), { scope: null, format: "summary" });
  assert.deepEqual(parseMode("  "), { scope: null, format: "summary" });
  assert.deepEqual(parseMode("full"), { scope: null, format: "full" });
  assert.deepEqual(parseMode(" JSON "), { scope: null, format: "json" });
  assert.deepEqual(parseMode("week"), { scope: "week", format: "summary" });
  assert.deepEqual(parseMode("  Month  "), { scope: "month", format: "summary" });
  assert.deepEqual(parseMode("all json"), { scope: "all", format: "json" });
  assert.deepEqual(parseMode("week summary"), { scope: "week", format: "summary" });
  assert.equal(parseMode("verbose"), null);
  assert.equal(parseMode("week full"), null);
  assert.equal(parseMode("week json full"), null);
  assert.deepEqual(SCOPES, ["week", "month", "all"]);
});
