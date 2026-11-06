import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMigrationChecksum } from './ledger-repair';

describe('verifyMigrationChecksum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-repair-'));
  writeFileSync(join(dir, 'm.sql'), 'select 1;');
  const sha256 = createHash('sha256').update('select 1;').digest('hex');

  test('passes when the file hashes to the pinned sha256', () => {
    expect(() => verifyMigrationChecksum(dir, { filename: 'm.sql', sha256 })).not.toThrow();
  });

  test('throws naming the file and both hashes when it does not', () => {
    expect(() => verifyMigrationChecksum(dir, { filename: 'm.sql', sha256: 'bad' })).toThrow(
      `Migration checksum mismatch for m.sql: expected bad, received ${sha256}.`,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
