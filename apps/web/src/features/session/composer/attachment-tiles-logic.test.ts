import { describe, expect, test } from 'bun:test';

import {
  fileExtension,
  isPreviewableTextExtension,
  truncateTextPreview,
} from './attachment-tiles-logic';

describe('fileExtension', () => {
  test('lower-cases a mixed-case extension', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf');
  });

  test('takes the last segment when a name has multiple dots', () => {
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  test('a dot-less name resolves to itself, lower-cased', () => {
    // `split('.').pop()` on a name with no dot returns the whole name — this
    // is deliberate, not a bug: it is what lets `isPreviewableTextExtension`
    // match bare filenames like `Dockerfile` via the `dockerfile` entry in its
    // set, with no special case needed.
    expect(fileExtension('Dockerfile')).toBe('dockerfile');
  });

  test('a dotfile with no further suffix resolves to the part after the dot', () => {
    expect(fileExtension('.gitignore')).toBe('gitignore');
  });
});

describe('isPreviewableTextExtension', () => {
  test('source and markup extensions are previewable', () => {
    for (const ext of ['ts', 'tsx', 'py', 'json', 'md', 'sh']) {
      expect(isPreviewableTextExtension(ext)).toBe(true);
    }
  });

  test('binary formats routed elsewhere are not previewable here', () => {
    for (const ext of ['png', 'pdf', 'zip', 'mp4', 'heic']) {
      expect(isPreviewableTextExtension(ext)).toBe(false);
    }
  });

  test('the empty extension is not previewable', () => {
    expect(isPreviewableTextExtension('')).toBe(false);
  });
});

describe('truncateTextPreview', () => {
  test('text at or under the cap passes through unchanged', () => {
    const text = 'one\ntwo\nthree';
    expect(truncateTextPreview(text, 12)).toBe(text);
  });

  test('cuts to exactly the first N lines', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateTextPreview(text, 12);
    expect(result.split('\n')).toHaveLength(12);
    expect(result.split('\n')[11]).toBe('line 11');
    expect(result).not.toContain('line 12');
  });

  test('defaults to 12 lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    expect(truncateTextPreview(text).split('\n')).toHaveLength(12);
  });

  test('an empty string stays empty', () => {
    expect(truncateTextPreview('')).toBe('');
  });

  test('a single line with no newline passes through', () => {
    expect(truncateTextPreview('just one line')).toBe('just one line');
  });
});
