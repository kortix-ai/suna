import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('legacy file transfer shell safety', () => {
  test('quotes shell arguments and encodes thread IDs before building remote commands', () => {
    const source = readFileSync(join(import.meta.dir, '../legacy/file-transfer.ts'), 'utf8');

    expect(source).toContain('function shellQuote(value: string)');
    expect(source).toContain('function toSafePathSegment(value: string)');
    expect(source).toContain('encodeURIComponent(value)');
    expect(source).toContain('const quotedDestPath = shellQuote(destPath);');
    expect(source).toContain('const quotedArchivePath = shellQuote(archivePath);');
    expect(source).toContain('rm -f ${shellQuote(ARCHIVE_PATH)}');
  });
});
