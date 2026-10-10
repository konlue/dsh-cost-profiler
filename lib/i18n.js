/**
 * Report-body translations for the cost profiler.
 *
 * The host half has no access to the app's UI language (it lives in the
 * renderer's locale registry), so the report language is a plugin config key
 * (`language: "en" | "zh"`, default `"en"`). Card chrome localization is
 * separate — it lives in lib/client.js and follows the app UI automatically.
 *
 * The English dictionary is the canonical key set: unknown languages and
 * missing keys fall back to it. JSON report *values* (the `window` field and
 * friends) intentionally stay English regardless of this table, so scripts
 * parsing `/cost json` see a language-stable contract.
 *
 * @module dsh-cost-profiler/i18n
 */

export const LANGUAGES = ["en", "zh"];

const STRINGS = {
  en: {
    // /cost command surface
    usage: "Usage: /cost [summary|full|json] or /cost [week|month|all] [summary|json]",
    unknownArg: "Unknown argument `{arg}`. {usage}",
    noSession: "No owning session: /cost must run inside an agent session.",
    commandDescription:
      "Show the token usage, latency and estimated cost of this session, or roll up recent sessions (/cost week)",

    // session report headline
    headlineCost: "Session cost {cost} (est)",
    headlineTrackingOff: "Session cost: tracking off",
    turn: "turn",
    turns: "turns",
    inTokens: "{n} in",
    outTokens: "{n} out",
    cacheHitPct: "{pct} cache hit",
    wallTime: "{n} wall",
    emptySession:
      "Session cost: nothing profiled in this session yet — the profile builds up as turns run. Run /cost again after the next exchange.",

    // session report detail lines
    turnsLabel: "Turns",
    messagesLabel: "Messages",
    retriesLabel: "Retries",
    wallLabel: "Wall",
    llmLabel: "LLM ≈",
    toolsLabel: "Tools ≈",
    tokensLabel: "Tokens",
    reasoningLabel: "reasoning",
    estimatedCostLabel: "Estimated cost",
    listPrices: "— API list prices ({schedule}), {currency}",
    peak: "peak",
    offPeak: "off-peak",

    // per-route table
    routeHeader: "Model route",
    inUncachedHeader: "In (uncached)",
    cacheHitHeader: "Cache hit",
    cacheWriteHeader: "Cache write",
    outHeader: "Out",
    reasoningHeader: "Reasoning",
    msgsHeader: "Msgs",
    estCostHeader: "Est. cost",

    // tools table
    toolHeader: "Tool",
    callsHeader: "Calls",
    totalHeader: "Total",
    maxHeader: "Max",
    errorsHeader: "Errors",
    slowestTools: "Slowest tools",
    moreTools: "_…and {n} more tools (see `/cost json`)._",

    // per-turn table
    turnsKept: "**Turns** (last {shown} of {total} kept)",
    turnsTrimmed:
      "_Older turns were trimmed from the detail view; the totals above still cover the whole session._",

    // notes
    costsNote:
      "_Costs are API list-price estimates for orientation only — subscription/quota billing may differ._",
    noPrice: "_No price configured for: {routes} — set them under the `prices` config key._",

    // cross-session report
    sessionsHeadline: "Sessions {cost} (est)",
    sessionsTrackingOff: "Sessions: tracking off",
    sessionsCountOne: "{n} session",
    sessionsCountMany: "{n} sessions",
    scopeWeek: "last 7 days",
    scopeMonth: "last 30 days",
    scopeAll: "all time",
    sessionsEmptyWindow: "Sessions: nothing profiled {window}",
    sessionsEmptyHint:
      "No session with profiled activity {window}. The rollup reads locally stored sessions — run `/cost all` to check every session, or come back after the next exchange.",
    workspaceHeader: "Workspace",
    sessionsCountHeader: "Sessions",
    sessionHeader: "Session",
    lastActiveHeader: "Last active",
    untitled: "untitled",
    privacyNote:
      "_Costs are API list-price estimates read from locally stored session data (titles and usage only — never message content). Subscription/quota billing may differ._",
    moreWorkspaces: "_…and {n} more workspaces (see `/cost {scope} json`)._",
    moreSessions: "_…and {n} more sessions (see `/cost {scope} json`)._",
    skippedSessions: "_Skipped {n} unreadable session(s)._",
  },

  zh: {
    usage: "用法：/cost [summary|full|json] 或 /cost [week|month|all] [summary|json]",
    unknownArg: "未知参数 `{arg}`。{usage}",
    noSession: "没有所属会话：/cost 必须在 agent 会话内运行。",
    commandDescription: "查看本会话的 token 用量、耗时与估算费用，或汇总近期会话（/cost week）",

    headlineCost: "会话费用 {cost}（估算）",
    headlineTrackingOff: "会话费用：统计已关闭",
    turn: "轮",
    turns: "轮",
    inTokens: "输入 {n}",
    outTokens: "输出 {n}",
    cacheHitPct: "缓存命中 {pct}",
    wallTime: "墙钟 {n}",
    emptySession: "会话费用：本会话还没有可统计的活动——剖析随对话轮次逐步累积。下一轮对话后再运行 /cost 查看。",

    turnsLabel: "轮次",
    messagesLabel: "消息",
    retriesLabel: "重试",
    wallLabel: "墙钟",
    llmLabel: "LLM ≈",
    toolsLabel: "工具 ≈",
    tokensLabel: "Token",
    reasoningLabel: "推理",
    estimatedCostLabel: "估算费用",
    listPrices: "—— API 牌价（{schedule}），{currency}",
    peak: "峰值",
    offPeak: "低谷",

    routeHeader: "模型路由",
    inUncachedHeader: "输入（未命中）",
    cacheHitHeader: "缓存命中",
    cacheWriteHeader: "缓存写入",
    outHeader: "输出",
    reasoningHeader: "推理",
    msgsHeader: "消息",
    estCostHeader: "估算费用",

    toolHeader: "工具",
    callsHeader: "调用",
    totalHeader: "总耗时",
    maxHeader: "最长",
    errorsHeader: "错误",
    slowestTools: "最慢工具",
    moreTools: "_…还有 {n} 个工具（见 `/cost json`）。_",

    turnsKept: "**轮次**（最近 {shown} / {total} 轮）",
    turnsTrimmed: "_更早的轮次已从明细中裁剪；上方总量仍覆盖整个会话。_",

    costsNote: "_费用为 API 牌价估算，仅供参照——订阅/配额计费可能不同。_",
    noPrice: "_未配置价格的路由：{routes}——请在 `prices` 配置键中设置。_",

    sessionsHeadline: "会话汇总 {cost}（估算）",
    sessionsTrackingOff: "会话汇总：统计已关闭",
    sessionsCountOne: "{n} 个会话",
    sessionsCountMany: "{n} 个会话",
    scopeWeek: "近 7 天",
    scopeMonth: "近 30 天",
    scopeAll: "全部会话",
    sessionsEmptyWindow: "会话汇总：{window}没有可统计的活动",
    sessionsEmptyHint:
      "{window}没有可统计活动的会话。汇总读取本地存储的会话——运行 `/cost all` 可查看全部会话，或下一轮对话后再来看。",
    workspaceHeader: "工作区",
    sessionsCountHeader: "会话数",
    sessionHeader: "会话",
    lastActiveHeader: "最近活跃",
    untitled: "未命名会话",
    privacyNote:
      "_费用为 API 牌价估算，读取自本地存储的会话数据（仅标题与用量数字——绝不读取消息正文）。订阅/配额计费可能不同。_",
    moreWorkspaces: "_…还有 {n} 个工作区（见 `/cost {scope} json`）。_",
    moreSessions: "_…还有 {n} 个会话（见 `/cost {scope} json`）。_",
    skippedSessions: "_已跳过 {n} 个无法读取的会话。_",
  },
};

/**
 * Translator for one language, with `{name}` interpolation.
 * @param language `"en"` or `"zh"` (anything else falls back to English)
 * @returns `(key, params?) => string`
 */
export function tFor(language) {
  const dict = STRINGS[language] ?? STRINGS.en;
  return (key, params) => {
    let text = dict[key] ?? STRINGS.en[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}
