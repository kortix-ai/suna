import { gatewayRequestLogs as logs } from '@kortix/db';
import { sql } from 'drizzle-orm';

// USD / million tokens. Snapshot of https://models.dev/api.json, openai /
// gpt-6.1-sol, retrieved 2026-10-27. Codex uses this model's API retail value,
// NOT a ChatGPT bill. Counts include cache reads/writes in inputTokens.
// This initial version deliberately has no fuzzy model matching.
export const LLM_VALUE_VERSION = 'models.dev:2026-10-27:v1';
export const LLM_VALUE_COVERAGE =
  'LLM retail usage value only; not a bill. Exact gpt-6.1-sol pricing only. Compute/browser excluded. Subscription fee unknown: no verified invoice amount; no project allocation.';
const rates = { input: 2, output: 10, cached: 0.1, write: 2.5 };
const longRates = { input: 4, output: 15, cached: 0.2, write: 5 };

export function estimateLlmValue(row: {
  provider: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}): number | null {
  if (!['openai', 'openai-codex'].includes(row.provider) || row.model !== 'gpt-6.1-sol')
    return null;
  if (
    ![row.input, row.output, row.cached, row.cacheWrite].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    row.cached + row.cacheWrite > row.input
  )
    return null;
  const r = row.input > 272000 ? longRates : rates;
  return (
    ((row.input - row.cached - row.cacheWrite) * r.input +
      row.cached * r.cached +
      row.cacheWrite * r.write +
      row.output * r.output) /
    1_000_000
  );
}

// Same rate snapshot in SQL so all reporting aggregates the same request-level
// values, never repricing a window's token sum across a context-price boundary.
const rate = (base: number, long: number) =>
  sql`case when ${logs.inputTokens} > 272000 then ${long}::numeric else ${base}::numeric end`;
export const rowLlmValueSql = sql<number | null>`case when
  ${logs.provider} in ('openai', 'openai-codex') and ${logs.resolvedModel} = 'gpt-6.1-sol'
  and ${logs.ok} and coalesce(${logs.metadata}->>'usageEstimated', 'false') <> 'true'
  and ${logs.inputTokens} >= 0 and ${logs.outputTokens} >= 0
  and ${logs.cachedTokens} >= 0 and ${logs.cacheWriteTokens} >= 0
  and ${logs.cachedTokens} + ${logs.cacheWriteTokens} <= ${logs.inputTokens}
  then ((${logs.inputTokens} - ${logs.cachedTokens} - ${logs.cacheWriteTokens}) * ${rate(rates.input, longRates.input)}
    + ${logs.cachedTokens} * ${rate(rates.cached, longRates.cached)}
    + ${logs.cacheWriteTokens} * ${rate(rates.write, longRates.write)}
    + ${logs.outputTokens} * ${rate(rates.output, longRates.output)}) / 1000000 end`;

export const llmValueFields = {
  estimated_usage_value: sql<number | null>`sum(${rowLlmValueSql})::float8`,
  priced_requests: sql<number>`count(${rowLlmValueSql})::int`,
  unpriced_requests: sql<number>`count(*) filter (where ${logs.ok} and ${rowLlmValueSql} is null)::int`,
};
export const llmValueBasis = {
  rate_version: LLM_VALUE_VERSION,
  rate_source: 'https://models.dev/api.json',
  coverage: LLM_VALUE_COVERAGE,
  subscription_fee: null,
  subscription_allocation: null,
};
