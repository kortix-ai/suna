import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sdk from '../../index';

/** Everything from the first declaration on: the part both copies must share. */
function body(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.indexOf('export const SESSION_LOG_SCHEMA'));
}

test('the SDK session-log types equal the api-contract copy', () => {
  const vendored = body(join(import.meta.dir, 'types.ts'));
  const contract = body(join(import.meta.dir, '../../../../api-contract/src/session-log/types.ts'));
  expect(vendored.length).toBeGreaterThan(5000);
  expect(vendored).toBe(contract);
});

test('the SDK root exports the kortix.session/2 constants', () => {
  expect(sdk.SESSION_LOG_SCHEMA).toBe('kortix.session/2');
  expect(sdk.SESSION_LOG_MINOR).toBe(1);
  expect(sdk.KNOWN_TOOL_KINDS).toContain('shell');
});

test('the SDK package does not depend on zod', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'));
  expect({ ...pkg.dependencies, ...pkg.peerDependencies }).not.toHaveProperty('zod');
});
