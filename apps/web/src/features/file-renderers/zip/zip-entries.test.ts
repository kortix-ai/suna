import { describe, expect, test } from 'bun:test';

import {
  archiveFileName,
  autoOpenFolders,
  buildZipTree,
  canPreviewZipEntry,
  isArchiveNoise,
  MAX_ZIP_PREVIEW_BYTES,
  safeZipPath,
  zipPreviewKind,
  zipSummary,
  type ZipEntry,
} from './zip-entries';

function entry(path: string, size = 10): ZipEntry {
  return { rawPath: path, path, name: path.split('/').pop() ?? path, size, date: null };
}

describe('safeZipPath', () => {
  test('strips the traversal segments that make zip-slip', () => {
    // Nothing here writes to disk, but this path names a download, and a `../`
    // in a filename is the browser's problem rather than ours.
    expect(safeZipPath('../../.ssh/authorized_keys')).toBe('.ssh/authorized_keys');
    expect(safeZipPath('a/../../b.txt')).toBe('a/b.txt');
  });

  test('normalizes Windows separators and drive letters', () => {
    expect(safeZipPath('C:\\docs\\report.pdf')).toBe('docs/report.pdf');
  });

  test('drops leading slashes and no-op segments', () => {
    expect(safeZipPath('/a/./b.txt')).toBe('a/b.txt');
  });

  test('a path that is nothing but traversal collapses to empty, for the caller to skip', () => {
    expect(safeZipPath('../..')).toBe('');
    expect(safeZipPath('/')).toBe('');
  });
});

describe('isArchiveNoise', () => {
  test('hides the AppleDouble forks Finder writes beside every entry', () => {
    // A 12-file Finder zip lists 24 rows without this, half of them
    // unopenable 200-byte duplicates of names already on screen.
    expect(isArchiveNoise('__MACOSX/report/._notes.md')).toBe(true);
    expect(isArchiveNoise('report/._notes.md')).toBe(true);
    expect(isArchiveNoise('.DS_Store')).toBe(true);
    expect(isArchiveNoise('report/.DS_Store')).toBe(true);
  });

  test('a dotfile the user actually authored is content, not noise', () => {
    expect(isArchiveNoise('.gitignore')).toBe(false);
    expect(isArchiveNoise('src/.env.example')).toBe(false);
    // Not a prefix match on the folder name.
    expect(isArchiveNoise('__MACOSX_backup/notes.md')).toBe(false);
  });
});

describe('buildZipTree', () => {
  test('derives folders from path prefixes, with no directory entries present', () => {
    // The case that matters: archives written by libraries carry no directory
    // records at all, and without this every row reads `src/lib/util.ts`.
    const root = buildZipTree([entry('src/lib/util.ts'), entry('src/index.ts'), entry('readme.md')]);

    expect(root.files.map((f) => f.name)).toEqual(['readme.md']);
    expect(root.folders.map((f) => f.name)).toEqual(['src']);
    const src = root.folders[0];
    expect(src.files.map((f) => f.name)).toEqual(['index.ts']);
    expect(src.folders[0].path).toBe('src/lib');
    expect(src.folders[0].files.map((f) => f.name)).toEqual(['util.ts']);
  });

  test('sorts numerically, so img2 precedes img10', () => {
    const root = buildZipTree([entry('img10.png'), entry('img2.png'), entry('img1.png')]);
    expect(root.files.map((f) => f.name)).toEqual(['img1.png', 'img2.png', 'img10.png']);
  });

  test('an empty archive is a root with nothing in it, not a throw', () => {
    const root = buildZipTree([]);
    expect(root.files).toEqual([]);
    expect(root.folders).toEqual([]);
  });

  test('a deep path creates every intermediate folder exactly once', () => {
    const root = buildZipTree([entry('a/b/c/one.txt'), entry('a/b/c/two.txt'), entry('a/b/d.txt')]);
    expect(root.folders).toHaveLength(1);
    const b = root.folders[0].folders[0];
    expect(b.path).toBe('a/b');
    expect(b.folders).toHaveLength(1);
    expect(b.folders[0].files).toHaveLength(2);
  });
});

describe('autoOpenFolders', () => {
  test('descends the wrapper folder a zip of a project always has', () => {
    // `report.zip` → `report/` → content. Opening onto one closed row that
    // says `report` tells the reader nothing the filename did not.
    const root = buildZipTree([entry('report/a.txt'), entry('report/b.txt')]);
    expect(autoOpenFolders(root)).toEqual(['report']);
  });

  test('descends a chain of only-children', () => {
    const root = buildZipTree([entry('dist/app/main.js')]);
    expect(autoOpenFolders(root)).toEqual(['dist', 'dist/app']);
  });

  test('stops at a fork — past it, auto-opening would be guessing', () => {
    const root = buildZipTree([entry('pkg/src/a.ts'), entry('pkg/test/b.ts')]);
    expect(autoOpenFolders(root)).toEqual(['pkg']);
  });

  test('stops where a file sits beside the folder', () => {
    const root = buildZipTree([entry('readme.md'), entry('src/a.ts')]);
    expect(autoOpenFolders(root)).toEqual([]);
  });
});

describe('zipSummary', () => {
  test('counts every file and folder at every depth, and totals uncompressed bytes', () => {
    const root = buildZipTree([
      entry('a.txt', 100),
      entry('src/b.ts', 250),
      entry('src/lib/c.ts', 650),
    ]);
    expect(zipSummary(root)).toEqual({ files: 3, folders: 2, bytes: 1000 });
  });

  test('an empty archive summarises to zeroes rather than NaN', () => {
    expect(zipSummary(buildZipTree([]))).toEqual({ files: 0, folders: 0, bytes: 0 });
  });
});

describe('zipPreviewKind', () => {
  test('text formats that survive a UTF-8 decode', () => {
    expect(zipPreviewKind('notes.md')).toBe('text');
    expect(zipPreviewKind('main.ts')).toBe('text');
    expect(zipPreviewKind('data.json')).toBe('text');
  });

  test('raster images the browser can draw', () => {
    expect(zipPreviewKind('shot.PNG')).toBe('image');
    expect(zipPreviewKind('photo.jpeg')).toBe('image');
  });

  test('svg reads as text — it is markup, and the source is what a zip reader wants', () => {
    expect(zipPreviewKind('logo.svg')).toBe('text');
  });

  test('extensionless conventions still preview', () => {
    expect(zipPreviewKind('LICENSE')).toBe('text');
    expect(zipPreviewKind('Dockerfile')).toBe('text');
    expect(zipPreviewKind('.gitignore')).toBe('text');
  });

  test('binaries have no honest inline preview', () => {
    // Extract is the real answer; a preview pane here renders mojibake.
    expect(zipPreviewKind('app.exe')).toBe('none');
    expect(zipPreviewKind('archive.tar.gz')).toBe('none');
    expect(zipPreviewKind('sheet.xlsx')).toBe('none');
  });
});

describe('canPreviewZipEntry', () => {
  test('a previewable format under the ceiling previews', () => {
    expect(canPreviewZipEntry(entry('notes.md', 1024))).toBe(true);
  });

  test('the ceiling is the UNCOMPRESSED size — that gap is what a zip bomb is', () => {
    // A 4MB zip can hold a 900MB log. The compressed size says nothing about
    // what inflating it costs, so the check must use the stored figure.
    expect(canPreviewZipEntry(entry('huge.log', MAX_ZIP_PREVIEW_BYTES + 1))).toBe(false);
    expect(canPreviewZipEntry(entry('big.log', MAX_ZIP_PREVIEW_BYTES))).toBe(true);
  });

  test('an unpreviewable format is refused at any size', () => {
    expect(canPreviewZipEntry(entry('app.exe', 1))).toBe(false);
  });
});

describe('archiveFileName', () => {
  test('keeps the archive’s own name', () => {
    expect(archiveFileName('report.zip')).toBe('report.zip');
  });

  test('takes the basename if handed a path', () => {
    expect(archiveFileName('/workspace/out/report.zip')).toBe('report.zip');
  });

  test('falls back rather than letting the browser name it after the blob URL', () => {
    // An empty `download` attribute saves a UUID with no extension, which then
    // will not open.
    expect(archiveFileName('')).toBe('archive.zip');
    expect(archiveFileName('   ')).toBe('archive.zip');
  });
});
