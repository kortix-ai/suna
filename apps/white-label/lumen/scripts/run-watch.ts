// Start a run as the firm's owner and print its progress until it ends (operator tool for local verification).
//   bun scripts/run-watch.ts review <matterId>        bun scripts/run-watch.ts ask <matterId> "<question>"
//   bun scripts/run-watch.ts watch <runId>
import { adminClient } from './convex-admin';

const c = adminClient();
const [kind, id, question] = process.argv.slice(2);
let runId = id;
if (kind === 'review') runId = (await c.mutation<{ runId: string }>('runs:startReviewAsOwner', { matterId: id })).runId;
if (kind === 'ask') runId = await c.mutation<string>('runs:askAsOwner', { matterId: id, question });
console.log('run', runId);
const t0 = Date.now();
let shown = 0;
for (;;) {
  const r = await c.query<any>('runs:debug', { runId });
  for (const e of r.events.slice(shown)) console.log(`${((e.at - t0) / 1000).toFixed(0).padStart(5)}s ${e.batchIndex ?? ' '} ${e.type.padEnd(12)} ${e.detail ?? ''}`);
  shown = r.events.length;
  if (['succeeded', 'partial', 'failed', 'canceled'].includes(r.status)) {
    console.log(JSON.stringify({ status: r.status, error: r.error, batches: r.batches }, null, 1));
    break;
  }
  await new Promise((res) => setTimeout(res, 3000));
}
