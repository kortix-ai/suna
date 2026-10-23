// Start a run as the firm's owner and print its progress until it ends (operator tool for local verification).
//   bun scripts/run-watch.ts review <matterId>        bun scripts/run-watch.ts ask <matterId> "<question>"
//   bun scripts/run-watch.ts contract <matterId> <documentId> <playbookId>   bun scripts/run-watch.ts diligence <matterId>
//   bun scripts/run-watch.ts draft <matterId> <templateId> '<fields JSON>'      bun scripts/run-watch.ts library <firmId>
//   bun scripts/run-watch.ts watch <runId>
import { adminClient } from './convex-admin';

const c = adminClient();
const [kind, id, question, extra] = process.argv.slice(2);
if (kind === 'library') {
  console.log(JSON.stringify(await c.mutation('library:defaultsAsOwner', { firmId: id }), null, 1));
  process.exit(0);
}
let runId = id;
if (kind === 'contract') runId = await c.mutation<string>('workflows:startContractReviewAsOwner', { matterId: id, documentId: question, playbookId: extra });
if (kind === 'diligence') runId = await c.mutation<string>('workflows:startDiligenceAsOwner', { matterId: id });
if (kind === 'draft') runId = await c.mutation<string>('workflows:startDraftAsOwner', { matterId: id, templateId: question, fields: JSON.parse(extra ?? '{}') });
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
