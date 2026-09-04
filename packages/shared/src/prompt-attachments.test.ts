import { describe, expect, test } from 'bun:test';

import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  isModelNativeAttachmentMime,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from './prompt-attachments';

describe('isModelNativeAttachmentMime', () => {
  test('allows the four decodable raster formats and PDF', () => {
    expect(isModelNativeAttachmentMime('image/png')).toBe(true);
    expect(isModelNativeAttachmentMime('image/jpeg')).toBe(true);
    expect(isModelNativeAttachmentMime('image/gif')).toBe(true);
    expect(isModelNativeAttachmentMime('IMAGE/WEBP')).toBe(true);
    expect(isModelNativeAttachmentMime('application/pdf')).toBe(true);
    expect(isModelNativeAttachmentMime('application/zip')).toBe(false);
    expect(isModelNativeAttachmentMime('text/markdown')).toBe(false);
  });

  // An `image/*` the model cannot decode is NOT native. Sending one inline
  // makes the runtime throw `ImageDecodeError` inside `prompt_async`, and
  // OpenCode then creates NO message at all — the text and every sibling
  // attachment die with it, while the inbox still records `delivered`
  // (2026-09-04: two SVG logos + a PDF, whole prompt vanished, transcript
  // showed only a spinner). Every one of these is in the composer's own
  // upload allowlist, so each is a live path to that failure.
  test('rejects image types the model cannot decode', () => {
    expect(isModelNativeAttachmentMime('image/svg+xml')).toBe(false);
    expect(isModelNativeAttachmentMime('IMAGE/SVG+XML')).toBe(false);
    expect(isModelNativeAttachmentMime('image/bmp')).toBe(false);
    expect(isModelNativeAttachmentMime('image/x-icon')).toBe(false);
    expect(isModelNativeAttachmentMime('image/heic')).toBe(false);
    expect(isModelNativeAttachmentMime('image/heif')).toBe(false);
    expect(isModelNativeAttachmentMime('image/tiff')).toBe(false);
  });

  test('ignores parameters and surrounding whitespace', () => {
    expect(isModelNativeAttachmentMime('  image/png ')).toBe(true);
    expect(isModelNativeAttachmentMime('image/png; charset=binary')).toBe(true);
    expect(isModelNativeAttachmentMime('image/svg+xml; charset=utf-8')).toBe(false);
  });
});

describe('sanitizePromptUploadFilename', () => {
  test('preserves Unicode and removes path separators and controls', () => {
    expect(sanitizePromptUploadFilename('../报告\u0000.zip')).toBe('.._报告_.zip');
  });

  test('removes C1 control characters', () => {
    expect(sanitizePromptUploadFilename('report\u0080\u009f.zip')).toBe('report__.zip');
  });

  test('stays within the daemon collision budget', () => {
    const name = sanitizePromptUploadFilename(`${'界'.repeat(100)}.zip`);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(
      MAX_PROMPT_UPLOAD_FILENAME_BYTES,
    );
    expect(name.endsWith('.zip')).toBe(true);
  });
});

test('promptFileReferenceXml escapes every XML attribute', () => {
  expect(
    promptFileReferenceXml({
      path: '/workspace/uploads/a&b.zip',
      mime: 'application/zip',
      filename: 'a"<b>.zip',
    }),
  ).toBe(
    '<file path="/workspace/uploads/a&amp;b.zip" mime="application/zip" filename="a&quot;&lt;b&gt;.zip">\n' +
      'This file has been uploaded and is available at the path above.\n' +
      '</file>',
  );
});
