/**
 * 05 — Cost pass-through: a marked-up usage table for re-billing.
 *
 * The shape a real "Kortix as a Backend" wrapper uses to charge its own
 * users: pull finalized per-session LLM + compute cost through
 * `billing.sessionCosts.list`, then apply a markup multiplier before showing
 * it to the end user. The list also reports cost records that the service
 * cannot reconcile to a current session.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... COST_MARKUP=1.2 \
 *     bun run examples/05-cost-passthrough.ts
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 */
import {
  createKortix,
  type Kortix,
  type SessionCostReconciliation,
  type SessionCostSummary,
} from '../src/index';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function listAllSessionCosts(kortix: Kortix, projectId: string) {
  const sessions: SessionCostSummary[] = [];
  let reconciliation: SessionCostReconciliation | null = null;
  let total = 0;
  let offset: number | null = 0;

  while (offset !== null) {
    const page = await kortix.billing.sessionCosts.list({
      projectId,
      limit: 100,
      offset,
    });
    sessions.push(...page.sessions);
    reconciliation ??= page.reconciliation;
    total = page.total;
    offset = page.next_offset;
  }

  return {
    sessions,
    total,
    reconciliation:
      reconciliation ??
      {
        llm_cost: 0,
        compute_cost: 0,
        total_cost: 0,
        request_count: 0,
        compute_window_count: 0,
        compute_seconds: 0,
      },
  };
}

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const markup = Number(process.env.COST_MARKUP ?? 1.2);

  if (!apiKey || !projectId) {
    console.error('Set KORTIX_API_KEY and KORTIX_PROJECT_ID and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });

  const [costs, credits] = await Promise.all([
    listAllSessionCosts(kortix, projectId),
    kortix.billing.creditBreakdown(),
  ]);

  console.log(`Caller's own Kortix credit balance: ${credits.total} (${credits.non_expiring} non-expiring)\n`);
  console.log(`Per-session finalized cost, ${markup}x markup applied:\n`);
  console.log('session_id                            raw_cost   billed_cost   requests');
  console.log('-------------------------------------------------------------------------');

  let rawTotal = 0;
  let billedTotal = 0;
  for (const s of costs.sessions) {
    const billed = round2(s.total_cost * markup);
    rawTotal += s.total_cost;
    billedTotal += billed;
    console.log(
      `${s.session_id.padEnd(38)} $${s.total_cost.toFixed(4).padStart(8)}   $${billed.toFixed(4).padStart(8)}   ${s.request_count}`,
    );
  }

  console.log('-------------------------------------------------------------------------');
  console.log(`TOTAL${' '.repeat(33)} $${round2(rawTotal).toFixed(2).padStart(8)}   $${round2(billedTotal).toFixed(2).padStart(8)}`);
  console.log(
    `Unreconciled cost: $${costs.reconciliation.total_cost.toFixed(4)} across ${costs.reconciliation.request_count} request(s) and ${costs.reconciliation.compute_window_count} compute window(s).`,
  );
  console.log(
    `Loaded ${costs.sessions.length} of ${costs.total} session(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
