import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { KORTIX_SCHEMA_BASE_URL } from '@kortix/manifest-schema';
import { runSchema } from '../commands/schema.ts';

const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
  process.stderr.write = ORIGINAL_STDERR_WRITE;
});

describe('kortix schema', () => {
  test('with no args prints the combined schema — the single canonical validator reference', () => {
    const code = runSchema([]);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.$id).toBe(`${KORTIX_SCHEMA_BASE_URL}/kortix.schema.json`);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  test('--version 1 prints only the v1 document', () => {
    const code = runSchema(['--version', '1']);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.$id).toBe(`${KORTIX_SCHEMA_BASE_URL}/kortix.v1.schema.json`);
  });

  test('--version 2 prints only the v2 document', () => {
    const code = runSchema(['--version', '2']);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.$id).toBe(`${KORTIX_SCHEMA_BASE_URL}/kortix.v2.schema.json`);
  });

  test('--url prints the canonical URL instead of the schema body', () => {
    const code = runSchema(['--url']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`${KORTIX_SCHEMA_BASE_URL}/kortix.schema.json`);
  });

  test('--version 2 --url prints the v2-specific URL', () => {
    const code = runSchema(['--version', '2', '--url']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`${KORTIX_SCHEMA_BASE_URL}/kortix.v2.schema.json`);
  });

  test('--help prints usage and does not print a schema', () => {
    const code = runSchema(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: kortix schema');
  });

  test('an invalid --version value fails with a clear error', () => {
    const code = runSchema(['--version', '3']);
    expect(code).toBe(1);
    expect(stderr).toContain('--version must be');
  });

  test('an unknown option fails', () => {
    const code = runSchema(['--bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown option');
  });
});
