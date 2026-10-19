import { describe, expect, test } from 'bun:test';

import {
  forEachLimit,
  MAX_UPLOAD_BYTES,
  partitionUploadBatch,
  resolveUploadTarget,
  rowDragIntent,
  uploadRejectionReason,
} from './upload-batch';

const MIME = 'application/x-kortix-file-path';

const candidate = (name: string, size: number) => ({ name, size });

describe('size guard — refuses before any bytes move', () => {
  test('the limit is the shared UPLOAD_LIMITS constant, not a local number', () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });

  test('a file at the limit is accepted; one byte over is refused', () => {
    expect(uploadRejectionReason(candidate('ok.bin', MAX_UPLOAD_BYTES))).toBeNull();
    expect(uploadRejectionReason(candidate('big.bin', MAX_UPLOAD_BYTES + 1))).not.toBeNull();
  });

  test('the rejection names the file, its size, and the limit', () => {
    // The 413 this replaces has an EMPTY body: the SDK could only say
    // "Upload failed (413): Request Entity Too Large" — no name, no limit.
    const reason = uploadRejectionReason(candidate('huge.mov', 210 * 1024 * 1024));
    expect(reason).toBe('huge.mov is 210.0 MB — the upload limit is 50 MB');
  });

  test('extension-less workspace files are not blocked — only size is checked', () => {
    // Deliberately NOT `isAllowedFile`: its extension allowlist would refuse
    // Dockerfile / Makefile / LICENSE, which a coding workspace is full of.
    expect(uploadRejectionReason(candidate('Dockerfile', 2048))).toBeNull();
    expect(uploadRejectionReason(candidate('LICENSE', 1024))).toBeNull();
  });

  test('partitioning keeps order and sends everything under the limit', () => {
    const files = [
      candidate('a.png', 10),
      candidate('huge.bin', MAX_UPLOAD_BYTES + 1),
      candidate('c.png', 20),
    ];
    const { accepted, rejected } = partitionUploadBatch(files);
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'c.png']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].file.name).toBe('huge.bin');
    expect(rejected[0].reason).toContain('huge.bin');
  });
});

describe('forEachLimit — parallel uploads, bounded', () => {
  test('never runs more than the limit at once, and runs every item once', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      seen.push(n);
      running--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('an empty batch resolves without calling fn', async () => {
    let calls = 0;
    await forEachLimit([], 4, async () => void calls++);
    expect(calls).toBe(0);
  });
});

describe('resolveUploadTarget — the folder dropped on wins', () => {
  test('a folder drop uploads into THAT folder, not the one being viewed', () => {
    // The bug: `targetPath` was always `currentPath`, so a drop onto a visible
    // folder row silently landed in the directory on screen.
    expect(
      resolveUploadTarget({
        currentPath: '/workspace/src',
        isRootPath: false,
        dropTargetDir: '/workspace/src/assets',
      }),
    ).toBe('/workspace/src/assets');
  });

  test('without a drop target it falls back to the current directory', () => {
    expect(resolveUploadTarget({ currentPath: '/workspace/src', isRootPath: false })).toBe(
      '/workspace/src',
    );
  });

  test('at the root it sends no path — the mutation defaults', () => {
    expect(
      resolveUploadTarget({ currentPath: '/', isRootPath: true, dropTargetDir: '  ' }),
    ).toBeUndefined();
  });

  test('a folder drop still wins while viewing the root', () => {
    expect(resolveUploadTarget({ currentPath: '/', isRootPath: true, dropTargetDir: 'docs' })).toBe(
      'docs',
    );
  });
});

describe('rowDragIntent — rows accept external files, not just internal moves', () => {
  const writable = { isDirectory: true, canMove: true, canUpload: true, moveMime: MIME };

  test('an internal drag over a folder is still a move', () => {
    expect(rowDragIntent([MIME, 'text/plain'], writable)).toBe('move');
  });

  test('external files over a folder are an upload, not ignored', () => {
    // Rows read only DRAG_MIME before, so this fell through to the page
    // handler and uploaded to the wrong directory with no indication.
    expect(rowDragIntent(['Files'], writable)).toBe('upload');
  });

  test('a file row never accepts a drop', () => {
    expect(rowDragIntent(['Files'], { ...writable, isDirectory: false })).toBeNull();
    expect(rowDragIntent([MIME], { ...writable, isDirectory: false })).toBeNull();
  });

  test('a read-only source accepts neither', () => {
    const readOnly = { ...writable, canMove: false, canUpload: false };
    expect(rowDragIntent(['Files'], readOnly)).toBeNull();
    expect(rowDragIntent([MIME], readOnly)).toBeNull();
  });

  test('an internal drag is never mistaken for an upload', () => {
    // Chromium reports both `Files` and the custom type on some internal
    // drags; the move MIME must win so a move never becomes an upload.
    expect(rowDragIntent([MIME, 'Files'], { ...writable, canUpload: false })).toBe('move');
    expect(rowDragIntent([MIME, 'Files'], { ...writable, canMove: false })).toBeNull();
  });

  test('an unrelated drag is ignored', () => {
    expect(rowDragIntent(['text/uri-list'], writable)).toBeNull();
  });
});
