import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import { readZipEntries } from './zip-renderer';
import { buildZipTree, MAX_ZIP_ENTRIES, zipSummary } from './zip-entries';

/**
 * These build a REAL archive and read it back, rather than hand-rolling a
 * fixture that agrees with the code by construction.
 *
 * That matters for one line in particular: `readZipEntries` reads
 * `file._data.uncompressedSize`, a PRIVATE jszip field, because the public
 * `JSZipObject` type exposes `name`/`dir`/`date`/permissions and no size at
 * all. A jszip upgrade that renames it would otherwise turn every row in the
 * archive into "0 B" with nothing failing.
 */
async function zipOf(files: Record<string, string>): Promise<JSZip> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return JSZip.loadAsync(bytes);
}

describe('readZipEntries against a real archive', () => {
  test('reports each entry’s uncompressed size — the private-field guard', async () => {
    const zip = await zipOf({ 'notes.txt': 'x'.repeat(5000), 'a/b.txt': 'hello' });
    const { entries } = readZipEntries(zip);

    expect(entries.find((e) => e.path === 'notes.txt')?.size).toBe(5000);
    expect(entries.find((e) => e.path === 'a/b.txt')?.size).toBe(5);
  });

  test('the size stays UNCOMPRESSED for a DEFLATE-compressed entry', async () => {
    // The distinction the ceiling in `canPreviewZipEntry` rests on: 5000
    // repeated bytes deflate to double digits, so a stored-size read would put
    // "51 B" on a row holding 5 KB — and would let a zip bomb straight past
    // the preview guard.
    const source = new JSZip();
    source.file('big.log', 'x'.repeat(5000));
    const packed = await source.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    expect(packed.byteLength).toBeLessThan(1000);

    const entries = readZipEntries(await JSZip.loadAsync(packed)).entries;
    expect(entries[0].size).toBe(5000);
  });

  test('derives the folder tree from a real archive’s paths', async () => {
    const zip = await zipOf({
      'report/summary.md': '# Summary',
      'report/data/rows.csv': 'a,b\n1,2',
      'readme.txt': 'hi',
    });
    const root = buildZipTree(readZipEntries(zip).entries);

    expect(root.files.map((f) => f.name)).toEqual(['readme.txt']);
    expect(root.folders.map((f) => f.name)).toEqual(['report']);
    expect(root.folders[0].folders[0].path).toBe('report/data');
    expect(zipSummary(root).files).toBe(3);
  });

  test('drops the Finder metadata a macOS zip carries', async () => {
    const zip = await zipOf({
      'notes.md': 'real',
      '__MACOSX/._notes.md': 'fork',
      '.DS_Store': 'junk',
    });
    expect(readZipEntries(zip).entries.map((e) => e.path)).toEqual(['notes.md']);
  });

  test('skips explicit directory records rather than listing them as files', async () => {
    const zip = new JSZip();
    zip.folder('docs')?.file('a.txt', 'a');
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const { entries } = readZipEntries(loaded);

    // `docs/` is a real record in this archive; it must not become a row.
    expect(entries.map((e) => e.path)).toEqual(['docs/a.txt']);
  });

  test('jszip resolves `..` itself, so a zip-slip name never reaches the tree', async () => {
    // Documented, not assumed: jszip runs its own `resolve()` over entry names
    // on both write and load. `safeZipPath` is the second line rather than the
    // first — it exists for what jszip does NOT normalize (below).
    const zip = await zipOf({ '../../etc/passwd': 'root:x:0:0' });
    expect(readZipEntries(zip).entries.map((e) => e.path)).toEqual(['etc/passwd']);
  });

  test('a name jszip does NOT normalize keeps a lookup key separate from its display path', async () => {
    // Backslashes are legal in an entry name and jszip leaves them alone, so
    // this is the real case where the sanitized path is not a key. Looking up
    // `entry.path` here returns null — an entry that renders fine and can
    // neither be previewed nor extracted.
    const zip = await zipOf({ 'docs\\report.txt': 'hi' });
    const [entry] = readZipEntries(zip).entries;

    expect(entry.path).toBe('docs/report.txt');
    expect(entry.rawPath).toBe('docs\\report.txt');
    expect(zip.file(entry.rawPath)).not.toBeNull();
    expect(zip.file(entry.path)).toBeNull();
  });

  test('an empty archive reads as no entries rather than throwing', async () => {
    const zip = await zipOf({});
    expect(readZipEntries(zip).entries).toEqual([]);
    expect(readZipEntries(zip).truncated).toBe(0);
  });

  test('a huge archive stops at the cap and REPORTS the remainder', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 25; i++) files[`f${i}.txt`] = 'x';
    const zip = await zipOf(files);
    const { entries, truncated } = readZipEntries(zip);

    expect(entries).toHaveLength(MAX_ZIP_ENTRIES);
    // The count is what the header prints. Silent truncation would read as
    // "this is the whole archive".
    expect(truncated).toBe(25);
  }, 30_000);
});
