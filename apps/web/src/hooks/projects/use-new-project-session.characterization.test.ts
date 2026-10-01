import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Pin the sequencing at the callback boundary before moving either job.
const source = readFileSync(new URL('./use-new-project-session.ts', import.meta.url), 'utf8');

test('warm adoption precedes ordinary create and ambiguous-create confirmation', () => {
  expect(source.indexOf('takeWarmSessionEntry(projectId')).toBeLessThan(source.indexOf('createProjectSession(projectId'));
  expect(source.indexOf('createProjectSession(projectId')).toBeLessThan(source.indexOf('confirmCommitted(async'));
  expect(source.indexOf('onAdopt(warm.session)')).toBeGreaterThan(source.indexOf('if (primed)'));
});

test('guard is released after every asynchronous create failure', () => {
  expect(source.indexOf('release();', source.indexOf('}).catch((err) =>'))).toBeGreaterThan(source.indexOf("resolveCreateFailure(code)"));
  expect(source.indexOf('opts?.onError?.();', source.indexOf('}).catch((err) =>'))).toBeGreaterThan(source.indexOf('release();', source.indexOf('}).catch((err) =>')));
});
