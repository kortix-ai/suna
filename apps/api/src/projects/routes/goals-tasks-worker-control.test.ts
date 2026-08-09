import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

async function routeBlock(summary: string): Promise<string> {
  const source = await Bun.file(join(import.meta.dir, 'goals-tasks.ts')).text();
  const start = source.indexOf(`summary: '${summary}'`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('summary:', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

describe('worker task-control route boundary', () => {
  for (const summary of [
    'Push an active goal through its synthetic trigger',
    'Record a project goal metric observation',
    'Create a generated project task',
    'Claim a generated project task',
    'Bind one bounded worker and durably queue its initial prompt',
    'Record authenticated semantic worker progress',
    'Atomically continue once, then block and escalate',
  ]) {
    test(`${summary} denies bound and spawned-unbound worker coordination`, async () => {
      const block = await routeBlock(summary);
      expect(block).toContain("taskWorkerControlDenial(c, 'control')");
    });
  }

  for (const summary of [
    'Complete a generated project task with cited evidence',
    'Block a generated project task with a reason',
  ]) {
    test(`${summary} confines a worker to its own doing binding`, async () => {
      const block = await routeBlock(summary);
      expect(block).toContain("taskWorkerControlDenial(c, 'own_task', taskId)");
    });
  }
});
