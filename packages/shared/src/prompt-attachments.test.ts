import { describe, expect, test } from 'bun:test';

import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  isModelNativeAttachmentMime,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from './prompt-attachments';

describe('isModelNativeAttachmentMime', () => {
  test('allows images and PDF only', () => {
    expect(isModelNativeAttachmentMime('image/png')).toBe(true);
    expect(isModelNativeAttachmentMime('IMAGE/WEBP')).toBe(true);
    expect(isModelNativeAttachmentMime('application/pdf')).toBe(true);
    expect(isModelNativeAttachmentMime('application/zip')).toBe(false);
    expect(isModelNativeAttachmentMime('text/markdown')).toBe(false);
  });
});

describe('sanitizePromptUploadFilename', () => {
  test('preserves Unicode and removes path separators and controls', () => {
    expect(sanitizePromptUploadFilename('../报告\u0000.zip')).toBe('.._报告_.zip');
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
