import { gatewayRequestLogs } from '@kortix/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * THE one definition of "what an LLM request cost YOU".
 *
 * `gateway_request_logs` carries two money columns and neither one is the
 * answer on its own:
 *
 *   `upstream_cost_precise` — what the upstream provider charged for the call.
 *   `final_cost_precise`    — what Kortix debited from the account's wallet.
 *
 * Every spend rollup in this repo used to sum `final_cost` alone. That is only
 * correct for Kortix-managed inference. On a BYOK deployment the resolver hands
 * back `billingMode: 'none'` with `markup: 0` (resolve-candidates.ts), so
 * `final_cost` is 0 for every request ever made — and the gateway dashboard,
 * the org-wide cost explorer, per-session cost, and gateway budgets all
 * reported `$0.0000` next to hundreds of millions of real, paid-for tokens.
 *
 * The three billing modes pay three different payees:
 *
 * | `billing_mode` | you paid                        | your spend                    |
 * |----------------|---------------------------------|-------------------------------|
 * | `credits`      | Kortix (managed inference)      | `final_cost`                  |
 * | `platform-fee` | your provider + Kortix's 10% fee| `upstream_cost + final_cost`  |
 * | `none`         | your provider directly          | `upstream_cost`               |
 *
 * On a `credits` row `upstream_cost` is KORTIX'S wholesale cost, not the
 * customer's — it is cost of goods sold. It is deliberately excluded from
 * `provider_cost` here (and zeroed on the wire in the gateway log serializer)
 * so no surface publishes the Kortix margin on a managed request.
 */

/** Numeric columns come back from postgres as strings; usage hints arrive as numbers. */
type NumericValue = number | string | null | undefined;

export interface LlmSpendRow {
  billingMode: string | null | undefined;
  upstreamCost: NumericValue;
  finalCost: NumericValue;
}

export interface LlmSpendBreakdown {
  /** Debited from the Kortix wallet — managed inference, or the BYOK platform fee. */
  kortix_cost: number;
  /** Paid straight to your own provider on your own key. Always 0 for managed inference. */
  provider_cost: number;
  /** `kortix_cost + provider_cost` — every dollar this request cost you. */
  total_cost: number;
}

function numberValue(value: NumericValue): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `billing_mode` is nullable and postdates the earliest gateway rows. Infer the
 * mode of a legacy row from whether it billed anything: a row that charged the
 * wallet was managed inference, one that charged nothing was BYOK. Defaulting
 * every legacy row to BYOK instead would add Kortix's wholesale cost on top of
 * what the customer was already charged and double-count managed spend.
 */
function billedByKortix(row: LlmSpendRow): boolean {
  if (row.billingMode) return row.billingMode === 'credits';
  return numberValue(row.finalCost) > 0;
}

/** Split one gateway request's money into who you paid. See the module doc. */
export function splitLlmSpend(row: LlmSpendRow): LlmSpendBreakdown {
  const kortixCost = numberValue(row.finalCost);
  const providerCost = billedByKortix(row) ? 0 : numberValue(row.upstreamCost);
  return {
    kortix_cost: kortixCost,
    provider_cost: providerCost,
    // Rounded at the same 10-decimal precision the money columns are stored
    // at, so float addition can't surface a 0.30000000000000004 in the UI.
    total_cost: Number((kortixCost + providerCost).toFixed(10)),
  };
}

/**
 * The SQL mirror of `billedByKortix`. Kept as one expression that every
 * aggregate composes from, so the mode rule can never drift between the row
 * helper above and the fifteen rollups that sum it.
 */
const rowBilledByKortixSql = sql`coalesce(
  ${gatewayRequestLogs.billingMode},
  case when ${gatewayRequestLogs.finalCost} > 0 then 'credits' else 'none' end
) = 'credits'`;

/** Per-row: what YOU paid your own provider (0 on a Kortix-managed row). */
export const rowProviderBilledSpendSql: SQL<string> = sql`(case when ${rowBilledByKortixSql} then 0 else ${gatewayRequestLogs.upstreamCost} end)`;

/** Per-row: what Kortix debited from your wallet. */
export const rowKortixBilledSpendSql: SQL<string> = sql`${gatewayRequestLogs.finalCost}`;

/** Per-row: every dollar the request cost you. */
export const rowTotalSpendSql: SQL<string> = sql`(${gatewayRequestLogs.finalCost} + ${rowProviderBilledSpendSql})`;

const aggregate = (rowExpression: SQL<string>) =>
  sql<number>`coalesce(sum(${rowExpression}), 0)::float8`;

/** Windowed total LLM spend. This is the headline number on every cost surface. */
export const totalSpendSql = aggregate(rowTotalSpendSql);

/** Windowed spend debited from the Kortix wallet. */
export const kortixBilledSpendSql = aggregate(rowKortixBilledSpendSql);

/** Windowed spend paid directly to your own providers. */
export const providerBilledSpendSql = aggregate(rowProviderBilledSpendSql);
