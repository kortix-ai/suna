import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Everything from the first declaration on: the part both copies must share. */
function body(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.indexOf('export const KORTIX_TRANSCRIPT_SCHEMA'));
}

test('the SDK transcript types equal the api-contract copy', () => {
  const sdk = body(join(import.meta.dir, 'transcript-types.ts'));
  const contract = body(join(import.meta.dir, '../../../../api-contract/src/transcript.ts'));
  expect(sdk.length).toBeGreaterThan(1000);
  expect(sdk).toBe(contract);
});
