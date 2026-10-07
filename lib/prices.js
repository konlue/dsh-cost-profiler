/**
 * Built-in price table and cost estimation.
 *
 * Defaults are DeepSeek API list prices in USD per 1M tokens, peak schedule
 * (checked 2026-10): deepseek-flash $0.30 in / $0.006 cache hit / $1.20 out,
 * deepseek-v4-pro $1.32 in / $0.044 cache hit / $3.96 out. DeepSeek bills no
 * separate cache-write fee, so `cacheWrite` defaults to 0. Off-peak pricing
 * is half of peak per DeepSeek's published schedule; `offPeak` applies the
 * same factor to user overrides.
 *
 * These are estimates for orientation only — subscription/quota billing and
 * third-party provider markups differ. Override via the `prices` config key,
 * and set `showCosts: false` to omit costs entirely.
 *
 * @module dsh-cost-profiler/prices
 */

export const CURRENCY_SYMBOLS = { USD: "$", CNY: "¥", EUR: "€", GBP: "£", JPY: "¥" };

/** DeepSeek API list prices, peak schedule, USD per 1M tokens. */
export const DEFAULT_PRICES = {
  "deepseek/deepseek-flash": { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 },
  "deepseek/deepseek-v4-pro": { input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 },
};

/** Bare-model fallbacks (route key without the provider prefix). */
export const MODEL_FALLBACK_PRICES = {
  "deepseek-flash": DEFAULT_PRICES["deepseek/deepseek-flash"],
  // Retired alias still accepted by the API, billed at Flash prices.
  "deepseek-v4-flash": DEFAULT_PRICES["deepseek/deepseek-flash"],
  "deepseek-v4-pro": DEFAULT_PRICES["deepseek/deepseek-v4-pro"],
};

/** DeepSeek publishes off-peak rates at half of peak. */
export const OFF_PEAK_FACTOR = 0.5;

const cleanPrice = (raw) => {
  if (raw === null || typeof raw !== "object") return null;
  const pick = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    input: pick(raw.input),
    output: pick(raw.output),
    cacheRead: pick(raw.cacheRead),
    cacheWrite: pick(raw.cacheWrite),
  };
};

/** Normalize the user-supplied `prices` config record; tolerant of junk. */
export function normalizePrices(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const price = cleanPrice(value);
    if (price !== null && typeof key === "string" && key.length > 0) out[key] = price;
  }
  return out;
}

/**
 * Resolve the price for one model route.
 * Precedence: user override on the full `provider/model` key, then on the
 * bare model, then the built-in table, then a user `default` catch-all.
 * @returns price object, or `null` when the model has no price configured.
 */
export function resolvePrice(routeKey, overrides = {}, offPeak = false) {
  const model = routeKey.includes("/") ? routeKey.slice(routeKey.indexOf("/") + 1) : routeKey;
  const raw =
    overrides[routeKey] ??
    overrides[model] ??
    DEFAULT_PRICES[routeKey] ??
    MODEL_FALLBACK_PRICES[model] ??
    overrides.default ??
    null;
  const price = cleanPrice(raw);
  if (price === null) return null;
  const factor = offPeak ? OFF_PEAK_FACTOR : 1;
  return {
    input: price.input * factor,
    output: price.output * factor,
    cacheRead: price.cacheRead * factor,
    cacheWrite: price.cacheWrite * factor,
  };
}

/** Cost of one route bucket under one resolved price, in currency units. */
export function routeCost(bucket, price) {
  if (!price) return null;
  return (
    (bucket.input * price.input +
      bucket.cacheRead * price.cacheRead +
      bucket.cacheWrite * price.cacheWrite +
      bucket.output * price.output) /
    1_000_000
  );
}
