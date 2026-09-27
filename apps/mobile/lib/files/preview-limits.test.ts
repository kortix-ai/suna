import { describe, expect, test } from 'bun:test';

import type { FilePreviewType } from '@/components/files/FilePreviewRenderers';

import {
  BINARY_PREVIEW_MAX_BYTES,
  CSV_MAX_COLUMNS,
  JSON_PRETTY_PRINT_MAX_CHARS,
  TEXT_PREVIEW_MAX_BYTES,
  TEXT_TRUNCATE_DISPLAY_BYTES,
  TEXT_TRUNCATE_MAX_BYTES,
  previewDecision,
  truncateForPreview,
} from './preview-limits';

const MB = 1024 * 1024;
const KB = 1024;
const type = (value: string) => value as FilePreviewType;

describe('preview limits', () => {
  test('uses the documented thresholds', () => {
    expect(TEXT_PREVIEW_MAX_BYTES).toBe(1 * MB);
    expect(TEXT_TRUNCATE_MAX_BYTES).toBe(5 * MB);
    expect(TEXT_TRUNCATE_DISPLAY_BYTES).toBe(200 * KB);
    expect(BINARY_PREVIEW_MAX_BYTES).toBe(15 * MB);
    expect(JSON_PRETTY_PRINT_MAX_CHARS).toBe(1 * MB);
    expect(CSV_MAX_COLUMNS).toBe(50);
  });
});

describe('previewDecision', () => {
  test('previews when the size is unknown or invalid', () => {
    expect(previewDecision({ size: undefined, previewType: type('text') })).toBe('preview');
    expect(previewDecision({ size: null, previewType: type('pdf') })).toBe('preview');
    expect(previewDecision({ size: Number.NaN, previewType: type('code') })).toBe('preview');
    expect(previewDecision({ size: -1, previewType: type('image') })).toBe('preview');
  });

  test.each(['text', 'code', 'json', 'csv', 'markdown', 'html', 'other'])(
    '%s previews up to 1 MB, truncates up to 5 MB, and refuses above',
    (t) => {
      expect(previewDecision({ size: 0, previewType: type(t) })).toBe('preview');
      expect(previewDecision({ size: 1 * MB, previewType: type(t) })).toBe('preview');
      expect(previewDecision({ size: 1 * MB + 1, previewType: type(t) })).toBe('truncate');
      expect(previewDecision({ size: 5 * MB, previewType: type(t) })).toBe('truncate');
      expect(previewDecision({ size: 5 * MB + 1, previewType: type(t) })).toBe('too-large');
    },
  );

  test.each(['pdf', 'docx', 'image', 'xlsx', 'binary'])(
    '%s previews up to 15 MB and refuses above, never truncates',
    (t) => {
      expect(previewDecision({ size: 2 * MB, previewType: type(t) })).toBe('preview');
      expect(previewDecision({ size: 15 * MB, previewType: type(t) })).toBe('preview');
      expect(previewDecision({ size: 15 * MB + 1, previewType: type(t) })).toBe('too-large');
    },
  );
});

describe('truncateForPreview', () => {
  test('returns short content unchanged', () => {
    expect(truncateForPreview('hello')).toEqual({ text: 'hello', truncated: false });
  });

  test('keeps exactly the display limit when content is longer', () => {
    const content = 'a'.repeat(TEXT_TRUNCATE_DISPLAY_BYTES + 10);
    const result = truncateForPreview(content);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(TEXT_TRUNCATE_DISPLAY_BYTES);
  });

  test('does not split a surrogate pair at the cut', () => {
    const content = 'a'.repeat(TEXT_TRUNCATE_DISPLAY_BYTES - 1) + '😀' + 'tail';
    const result = truncateForPreview(content);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(TEXT_TRUNCATE_DISPLAY_BYTES - 1);
    const last = result.text.charCodeAt(result.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
