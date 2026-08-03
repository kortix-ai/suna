import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_SOURCE_ROOT = resolve(import.meta.dir, '../..');
const THIS_FILE = resolve(import.meta.path);
const FORBIDDEN_CLIENT_WARM_SESSION_REFERENCES = [
  'ensureWarmProjectSession',
  'claimWarmProjectSession',
  'WARM_PROJECT_SESSIONS_ENABLED',
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe('client warm-session architecture', () => {
  test('web source cannot ensure or claim speculative sessions', () => {
    const violations = sourceFiles(WEB_SOURCE_ROOT).flatMap((path) => {
      if (path === THIS_FILE) return [];
      const source = readFileSync(path, 'utf8');
      return FORBIDDEN_CLIENT_WARM_SESSION_REFERENCES.filter((reference) =>
        source.includes(reference),
      ).map((reference) => `${path.slice(WEB_SOURCE_ROOT.length + 1)}: ${reference}`);
    });

    expect(violations).toEqual([]);
  });
});
