import { expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runtimeFingerprint } from './self-restart';

test('an update that swaps a runtime file in place changes the fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-restart-'));
  try {
    const binary = join(dir, 'Kortix');
    writeFileSync(binary, 'v1');
    const started = runtimeFingerprint([binary]);
    expect(runtimeFingerprint([binary])).toBe(started);
    // An app updater writes the new bundle beside the old one and renames it over.
    writeFileSync(join(dir, 'next'), 'v1');
    renameSync(join(dir, 'next'), binary);
    expect(runtimeFingerprint([binary])).not.toBe(started);
    rmSync(binary);
    expect(runtimeFingerprint([binary])).toBe('missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
