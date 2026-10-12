import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The api-contract module, from its header on, with the one import path this copy changes. */
function body(file: string, transcriptPath: string): string {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.indexOf('/**\n * `fromV1` and `toV1`')).replaceAll(`'${transcriptPath}'`, "'<transcript>'");
}

test('the SDK fromV1/toV1 equal the api-contract copy', () => {
  const vendored = body(join(import.meta.dir, 'v1.ts'), '../runtime/transcript-types');
  const contract = body(join(import.meta.dir, '../../../../api-contract/src/session-log/v1.ts'), '../transcript');
  expect(vendored.length).toBeGreaterThan(20_000);
  expect(vendored).toBe(contract);
});

test('the SDK copy imports no zod and no api-contract', () => {
  const text = readFileSync(join(import.meta.dir, 'v1.ts'), 'utf8');
  const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  expect(imports.sort()).toEqual(['../runtime/transcript-types', '../runtime/transcript-types', './types']);
});
