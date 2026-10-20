import { settleGatewaySpendDay } from '../llm-gateway/budgets';
import { runWorkerTick } from '../shared/audit-scope';
import { leaderTimer } from '../shared/leader-timer';

const IDLE_MS = 60 * 60_000;
const BACKLOG_MS = 5_000;

// Leader only, serial: recompute one closed pending day of the gateway spend
// running total (gateway_spend_pending_days) per tick. Every 5 s while days
// are pending, hourly once none is: the install day closes at UTC midnight.
const worker = leaderTimer(async () => {
  const settled = await runWorkerTick('gateway-spend-backfill', settleGatewaySpendDay);
  return settled ? BACKLOG_MS : IDLE_MS;
}, { name: 'gateway-spend-backfill' });

export const startGatewaySpendBackfillWorker = worker.start;
export const stopGatewaySpendBackfillWorker = worker.stop;
