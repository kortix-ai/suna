import { afterAll, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFileSet } from './load-file-set';
import { utcStamp } from './utc-stamp';

const dir = mkdtempSync(join(tmpdir(), 'db-helpers-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); jest.useRealTimers(); });
test('file sets preserve entries and deduplicate, tolerating absent and malformed files', () => {
  const file = join(dir, 'files.json');
  expect(loadFileSet(file)).toEqual(new Set());
  writeFileSync(file, '{');
  expect(loadFileSet(file)).toEqual(new Set());
  writeFileSync(file, JSON.stringify({ files: ['one.sql', 'two.sql', 'one.sql'] }));
  expect(loadFileSet(file)).toEqual(new Set(['one.sql', 'two.sql']));
  writeFileSync(file, 'null');
  expect(loadFileSet(file)).toEqual(new Set());
});
test('UTC stamp pads every field including milliseconds', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-02T03:04:05.006Z'));
  expect(utcStamp()).toBe('20260102030405006');
  jest.setSystemTime(new Date('2026-12-31T23:59:59.999Z'));
  expect(utcStamp()).toBe('20261231235959999');
  jest.useRealTimers();
});
