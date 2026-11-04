import { settleGatewaySpendDay } from '../../llm-gateway/budgets';
import { settleLastGatewaySessionDay } from '../../llm-gateway/session-rollup';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const IDLE_MS = 5 * 60_000;
const BACKLOG_MS = 5_000;

// Leader only, serial: settle one closed pending day of the gateway spend
// running total (gateway_spend_pending_days) per tick, then one closed day of
// the gateway sessions rollup (marked in gateway_session_days, KRTX-4021).
// Every 5 s while days are pending, every 5 minutes once none is: the rollup
// settles yesterday in the first tick that sees it closed (minutes past UTC
// midnight), and the spend install day closes at UTC midnight.
const worker = leaderTimer(async () => {
  const spendSettled = await runWorkerTick('gateway-spend-backfill', settleGatewaySpendDay);
  const rollupSettled = await runWorkerTick('gateway-spend-backfill', settleLastGatewaySessionDay);
  return spendSettled || rollupSettled ? BACKLOG_MS : IDLE_MS;
}, { name: 'gateway-spend-backfill' });

export const startGatewaySpendBackfillWorker = worker.start;
export const stopGatewaySpendBackfillWorker = worker.stop;
