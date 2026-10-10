/**
 * Cross-session history: scan the local DSH home for past sessions and turn
 * their stored usage into one record per session, plus pure aggregation over
 * those records. Read-only — this module never writes and never reads message
 * content, only titles, timestamps and usage/timing numbers.
 *
 * Data precedence per session:
 *   1. our own `costProfiler` checkpoint (per-model-route buckets, richest),
 *   2. the official `tokenUsage` checkpoint (session totals without routes;
 *      priced via the session's last-used model or the `default` price key),
 *   3. replaying the session log (independent of any checkpoint).
 *
 * Session layout under the DSH home (`$DSH_HOME` or `~/.dsh`):
 *   sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd   (event log)
 *   storages/session_projcache/sessions/<session-id>.json          (checkpoints)
 *
 * The log is append-only multi-frame zstd; the writer's lock never blocks
 * readers, but a torn tail frame can be observed mid-append — decoding
 * tolerates that by ignoring any frame that fails to decompress.
 *
 * @module dsh-cost-profiler/history
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { applyEvent, tokenTotals } from "./fold.js";
import { resolvePrice, routeCost } from "./prices.js";

/** Cross-session scopes accepted after `/cost`. */
export const SCOPES = ["week", "month", "all"];

/** Look-back window per scope, in days (`all` = unbounded). */
export const SCOPE_DAYS = { week: 7, month: 30 };
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** DSH home directory (same precedence rule as `dsh-home-paths`). */
export function historyHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

function isZstdMagic(buffer, offset) {
  return (
    offset + 4 <= buffer.length &&
    buffer[offset] === ZSTD_MAGIC[0] &&
    buffer[offset + 1] === ZSTD_MAGIC[1] &&
    buffer[offset + 2] === ZSTD_MAGIC[2] &&
    buffer[offset + 3] === ZSTD_MAGIC[3]
  );
}

/**
 * Decode a multi-frame zstd session log into parsed JSON lines. Frames are
 * parsed independently — the writer appends whole lines per frame, but a
 * frame's text need not end with a newline. A final torn frame (writer
 * mid-append) is skipped silently.
 */
export function decodeSessionLog(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (isZstdMagic(buffer, i)) starts.push(i);
  }
  if (starts.length === 0) return [];
  const lines = [];
  for (let f = 0; f < starts.length; f += 1) {
    const end = f + 1 < starts.length ? starts[f + 1] : buffer.length;
    let chunk;
    try {
      chunk = zlib.zstdDecompressSync(buffer.subarray(starts[f], end)).toString("utf8");
    } catch (error) {
      // Only the trailing frame can be torn; interior failures mean corruption.
      if (f !== starts.length - 1) throw error;
      continue;
    }
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch (error) {
        // Skip partial lines rather than losing the rest of the frame.
      }
    }
  }
  return lines;
}

const zeroRoute = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0 });

function routesHaveUsage(routes) {
  return Object.values(routes).some(
    (bucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite + bucket.reasoning > 0,
  );
}

function recordFromProjcache(proj) {
  const rows = proj?.record?.rows ?? {};
  const identity = proj?.record?.identity ?? {};
  const stats = rows.sessionStats?.val ?? {};
  const profiler = rows.costProfiler?.val;

  let routes = null;
  let source = null;
  let usage = { turns: stats.turns ?? 0, llmMs: stats.llmMs ?? 0, toolMs: stats.toolMs ?? 0 };

  const totals = profiler?.totals;
  if (totals && routesHaveUsage(totals.routes ?? {})) {
    routes = {};
    for (const [key, bucket] of Object.entries(totals.routes)) {
      routes[key] = { ...zeroRoute(), ...bucket };
    }
    source = "profiler";
    usage = { turns: totals.turns ?? 0, llmMs: totals.llmMs ?? 0, toolMs: totals.toolMs ?? 0 };
  } else if (rows.tokenUsage?.val?.totals) {
    const t = rows.tokenUsage.val.totals;
    const lastUsed = rows.modelSelection?.val?.lastUsed;
    const routeKey =
      lastUsed?.provider && lastUsed?.model ? `${lastUsed.provider}/${lastUsed.model}` : "unknown/unknown";
    routes = {
      [routeKey]: {
        ...zeroRoute(),
        input: t.uncachedInputTokens ?? 0,
        output: t.outputTokens ?? 0,
        cacheRead: t.cacheReadTokens ?? 0,
        cacheWrite: t.cacheWriteTokens ?? 0,
      },
    };
    source = "official";
  }
  if (source === null) return null;

  return {
    id: identity.sessionId ?? proj?.record?.sessionId ?? null,
    cwd: identity.cwd ?? null,
    title: typeof rows.title?.val === "string" ? rows.title.val : null,
    createdAt: identity.createdAt ?? null,
    lastPromptAt: rows.sessionListMetadata?.val?.lastPromptAt ?? null,
    routes,
    source,
    usage,
  };
}

function recordFromLog(logPath) {
  let lines;
  try {
    lines = decodeSessionLog(fs.readFileSync(logPath));
  } catch (error) {
    return null;
  }
  let header = null;
  let state = null;
  for (const line of lines) {
    if (line === null || typeof line !== "object") continue;
    if (line.type === "session") {
      header = line;
      continue;
    }
    state = applyEvent(state, line);
  }
  if (!state || (state.totals.msgs === 0 && tokenTotals(state.totals.routes).input === 0)) return null;

  const routes = {};
  for (const [key, bucket] of Object.entries(state.totals.routes)) {
    routes[key] = { ...zeroRoute(), ...bucket };
  }
  return {
    id: header?.id ?? null,
    cwd: header?.cwd ?? null,
    title: null,
    createdAt: header?.createdAt ?? null,
    lastPromptAt: null,
    routes,
    source: "replay",
    usage: { turns: state.totals.turns, llmMs: state.totals.llmMs, toolMs: state.totals.toolMs },
  };
}

function workspaceNameOf(cwd) {
  if (typeof cwd !== "string" || cwd === "") return "unknown";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || trimmed;
}

function recordActivityMs(record, logMtimeMs) {
  return record.lastPromptAt ?? logMtimeMs ?? record.createdAt ?? 0;
}

/**
 * Scan the DSH home and produce one usage record per session that has any
 * profiled activity, sorted most-recently-active first.
 * @param opts `{ root?, now?, days?, skipSessionIds? }`
 *   - `days`: keep only sessions active within the last N days (null = all)
 * @returns `{ records, errors }`; `records` carry
 *   `{ id, cwd, workspaceName, title, createdAt, lastPromptAt, routes, usage, source, activityMs }`
 */
export function collectSessions(opts = {}) {
  const root = opts.root ?? historyHome();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : null;
  const cutoff = days === null ? null : now - days * 86_400_000;
  const skip = new Set(opts.skipSessionIds ?? []);

  const sessionsDir = path.join(root, "sessions");
  const projcacheDir = path.join(root, "storages", "session_projcache", "sessions");
  const errors = [];
  const records = [];

  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    return { records: [], errors: [`sessions directory not readable: ${root}`] };
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(sessionsDir, workspace.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch (error) {
      errors.push(`workspace not readable: ${workspace.name}`);
      continue;
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(workspaceDir, session.name);
      const logPath = path.join(sessionDir, "session.v4.jsonl.zstd");
      if (!fs.existsSync(logPath)) continue;

      let logMtimeMs = null;
      try {
        logMtimeMs = fs.statSync(logPath).mtimeMs;
      } catch (error) {
        // Fall through: activity falls back to createdAt.
      }

      let record = null;
      const projPath = path.join(projcacheDir, `${session.name}.json`);
      try {
        if (fs.existsSync(projPath)) {
          record = recordFromProjcache(JSON.parse(fs.readFileSync(projPath, "utf8")));
        }
      } catch (error) {
        errors.push(`projcache unreadable: ${session.name}`);
      }
      if (record === null) {
        const replayed = recordFromLog(logPath);
        if (replayed === null) continue; // no profiled activity (or unreadable)
        record = replayed;
      }

      record.id = record.id ?? session.name;
      record.workspaceName = workspaceNameOf(record.cwd);
      record.activityMs = recordActivityMs(record, logMtimeMs);

      if (skip.has(record.id) || skip.has(session.name)) continue;
      if (cutoff !== null && record.activityMs < cutoff) continue;

      const usageEmpty = record.usage.turns === 0 && tokenTotals(record.routes).input === 0;
      if (usageEmpty) continue;
      records.push(record);
    }
  }

  records.sort((a, b) => b.activityMs - a.activityMs);
  return { records, errors };
}

/**
 * Session cost under the normalized config (see ./report.js). `null` when no
 * price resolves for any route — surfaced as `—` instead of a wrong number.
 */
export function sessionCost(record, cfg) {
  let estimate = 0;
  let priced = false;
  for (const [key, bucket] of Object.entries(record.routes)) {
    const cost = routeCost(bucket, resolvePrice(key, cfg.prices, cfg.offPeak));
    if (cost === null) continue;
    estimate += cost;
    priced = true;
  }
  return priced ? estimate : null;
}

function addToWorkspace(map, record, cost) {
  const key = record.workspaceName;
  const prev = map.get(key) ?? { workspace: key, sessions: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, estimate: 0, priced: false };
  prev.sessions += 1;
  const tokens = tokenTotals(record.routes);
  prev.tokens.input += tokens.input;
  prev.tokens.output += tokens.output;
  prev.tokens.cacheRead += tokens.cacheRead;
  prev.tokens.cacheWrite += tokens.cacheWrite;
  if (cost !== null) {
    prev.estimate += cost;
    prev.priced = true;
  }
  map.set(key, prev);
}

/**
 * Aggregate collected records for the report: grand totals, per-workspace
 * rollup and per-session cost decoration. Pure.
 */
export function aggregateSessions(records, cfg) {
  const workspaces = new Map();
  const totals = {
    sessions: records.length,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    estimate: 0,
    unpriced: new Set(),
  };
  const sessions = records.map((record) => {
    const tokens = tokenTotals(record.routes);
    totals.turns += record.usage.turns;
    totals.tokens.input += tokens.input;
    totals.tokens.output += tokens.output;
    totals.tokens.cacheRead += tokens.cacheRead;
    totals.tokens.cacheWrite += tokens.cacheWrite;
    totals.tokens.reasoning += tokens.reasoning;
    for (const key of Object.keys(record.routes)) {
      if (resolvePrice(key, cfg.prices, cfg.offPeak) === null) totals.unpriced.add(key);
    }
    const cost = sessionCost(record, cfg);
    if (cost !== null) totals.estimate += cost;
    addToWorkspace(workspaces, record, cost);
    return { ...record, tokens, cost };
  });

  const byWorkspace = [...workspaces.values()].sort((a, b) => b.estimate - a.estimate || b.tokens.input + b.tokens.cacheRead - (a.tokens.input + a.tokens.cacheRead));
  return { totals: { ...totals, unpriced: [...totals.unpriced] }, byWorkspace, sessions };
}
