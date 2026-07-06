/**
 * 05 — Cost pass-through: a marked-up usage table for re-billing.
 *
 * The shape a real "Kortix as a Backend" wrapper uses to charge its own
 * users: pull per-session LLM + compute cost from the gateway
 * (`project(id).gateway.sessions`) and the caller's own credit balance
 * (`billing.creditBreakdown`), then apply a markup multiplier before showing
 * it to the end user. This mirrors `apps/whitelabel-demo`'s `/usage` route
 * (`src/app/api/usage/route.ts`), rewritten to go through the SDK facade
 * instead of a raw upstream `fetch`.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... COST_MARKUP=1.2 \
 *     bun run examples/05-cost-passthrough.ts
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 */
import { createKortix } from '../src/index';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

  const [sessions, credits] = await Promise.all([
    kortix.project(projectId).gateway.sessions(30), // trailing 30 days
    kortix.billing.creditBreakdown(),
  ]);

  console.log(`Caller's own Kortix credit balance: ${credits.total} (${credits.non_expiring} non-expiring)\n`);
  console.log(`Per-session cost, last ${sessions.window_days} day(s), ${markup}x markup applied:\n`);
  console.log('session_id                            raw_cost   billed_cost   requests');
  console.log('-------------------------------------------------------------------------');

  let rawTotal = 0;
  let billedTotal = 0;
  for (const s of sessions.sessions) {
    const billed = round2(s.total_cost * markup);
    rawTotal += s.total_cost;
    billedTotal += billed;
    console.log(
      `${s.session_id.padEnd(38)} $${s.total_cost.toFixed(4).padStart(8)}   $${billed.toFixed(4).padStart(8)}   ${s.requests}`,
    );
  }

  console.log('-------------------------------------------------------------------------');
  console.log(`TOTAL${' '.repeat(33)} $${round2(rawTotal).toFixed(2).padStart(8)}   $${round2(billedTotal).toFixed(2).padStart(8)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
