import { describe, expect, test } from 'bun:test';

import {
  beginUploadBatch,
  describeUploadSuccess,
  IDLE_UPLOAD_PROGRESS,
  MAX_UPLOAD_BYTES,
  partitionUploadBatch,
  resolveUploadTarget,
  rowDragIntent,
  settleUploadUnit,
  uploadProgressLabel,
  uploadProgressPercent,
  uploadRejectionReason,
} from './upload-batch';

const MIME = 'application/x-kortix-file-path';

const candidate = (name: string, size: number) => ({ name, size });

describe('describeUploadSuccess — names what actually uploaded', () => {
  test('a partial batch names the file that succeeded, not files[0]', () => {
    // The bug: dropping a.png, b.png, c.png with only c.png succeeding
    // reported "Uploaded a.png", because the toast read `files[0].name`.
    expect(describeUploadSuccess(['c.png'])).toBe('Uploaded c.png');
    expect(describeUploadSuccess(['c.png'])).not.toContain('a.png');
  });

  test('two successes are both named', () => {
    expect(describeUploadSuccess(['a.png', 'c.png'])).toBe('Uploaded a.png and c.png');
  });

  test('three or more collapse to a count of the SUCCEEDED files', () => {
    expect(describeUploadSuccess(['a.png', 'b.png', 'c.png'])).toBe('Uploaded 3 files');
  });

  test('no successes produce no toast at all', () => {
    expect(describeUploadSuccess([])).toBeNull();
  });

  test('the count form is never singular — the old `s` branch was dead code', () => {
    // `successCount > 1 ? 's' : ''` could only ever run with count >= 2.
    for (let n = 2; n <= 5; n++) {
      const names = Array.from({ length: n }, (_, i) => `f${i}.txt`);
      expect(describeUploadSuccess(names)).not.toContain('1 file ');
      if (n > 2) expect(describeUploadSuccess(names)).toBe(`Uploaded ${n} files`);
    }
  });
});

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

describe('upload progress — determinate and safe across overlapping batches', () => {
  test('a batch reports real progress, not an indeterminate pulse', () => {
    let p = beginUploadBatch(IDLE_UPLOAD_PROGRESS, 12);
    expect(uploadProgressLabel(p)).toBe('1 of 12');
    expect(uploadProgressPercent(p)).toBe(0);

    p = settleUploadUnit(settleUploadUnit(p));
    expect(uploadProgressLabel(p)).toBe('3 of 12');
    expect(uploadProgressPercent(p)).toBe(17);
  });

  test('batch B finishing does NOT blank the indicator while batch A runs', () => {
    // The race: `setUploadingCount(files.length)` then `setUploadingCount(0)`
    // after each loop, so the shorter batch zeroed the longer one's bar.
    let p = beginUploadBatch(IDLE_UPLOAD_PROGRESS, 3); // batch A: 3 files
    p = beginUploadBatch(p, 2); // batch B starts: 2 more
    expect(p).toEqual({ done: 0, total: 5 });

    p = settleUploadUnit(settleUploadUnit(p)); // both of B's files finish
    expect(p).toEqual({ done: 2, total: 5 });
    expect(uploadProgressLabel(p)).toBe('3 of 5');
  });

  test('the indicator clears only when nothing is outstanding', () => {
    let p = beginUploadBatch(IDLE_UPLOAD_PROGRESS, 2);
    p = settleUploadUnit(p);
    expect(p.total).toBe(2);
    p = settleUploadUnit(p);
    expect(p).toEqual(IDLE_UPLOAD_PROGRESS);
    expect(uploadProgressPercent(p)).toBe(0);
    expect(uploadProgressLabel(p)).toBe('');
  });

  test('an empty batch never opens the indicator', () => {
    expect(beginUploadBatch(IDLE_UPLOAD_PROGRESS, 0)).toEqual(IDLE_UPLOAD_PROGRESS);
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
    expect(
      resolveUploadTarget({ currentPath: '/', isRootPath: true, dropTargetDir: 'docs' }),
    ).toBe('docs');
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
