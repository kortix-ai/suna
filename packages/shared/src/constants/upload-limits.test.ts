import { describe, test, expect } from 'bun:test';
import {
  UPLOAD_LIMITS,
  ALLOWED_EXTENSIONS,
  EXTRACTABLE_EXTENSIONS,
  formatFileSize,
  isAllowedFile,
  isExtractableArchive,
} from './upload-limits';

describe('UPLOAD_LIMITS', () => {
  test('keeps byte and megabyte file size limits consistent', () => {
    expect(UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES).toBe(UPLOAD_LIMITS.MAX_FILE_SIZE_MB * 1024 * 1024);
  });

  test('keeps the zip total size limit larger than the single file limit', () => {
    expect(UPLOAD_LIMITS.MAX_ZIP_TOTAL_SIZE_BYTES).toBeGreaterThan(
      UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES,
    );
  });
});

describe('formatFileSize', () => {
  test('formats sub-kilobyte sizes in bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  test('formats kilobyte sizes with one decimal', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  test('formats megabyte sizes with one decimal', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB');
  });

  test('switches units exactly at the boundaries', () => {
    expect(formatFileSize(1024 * 1024 - 1)).toContain('KB');
    expect(formatFileSize(1024 * 1024)).toContain('MB');
  });
});

describe('isAllowedFile', () => {
  test('allows a supported extension within the size limit', () => {
    expect(isAllowedFile({ name: 'doc.pdf', size: 1000 })).toEqual({ allowed: true });
  });

  test('allows a file with no size provided', () => {
    expect(isAllowedFile({ name: 'image.png' })).toEqual({ allowed: true });
  });

  test('rejects an unsupported extension with a reason', () => {
    const result = isAllowedFile({ name: 'malware.xyzabc' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not supported');
  });

  test('rejects files that exceed the maximum size with a reason', () => {
    const result = isAllowedFile({
      name: 'big.pdf',
      size: UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES + 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  test('allows a file exactly at the size limit', () => {
    expect(
      isAllowedFile({ name: 'edge.pdf', size: UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES }),
    ).toEqual({ allowed: true });
  });

  test('matches extensions case-insensitively', () => {
    expect(isAllowedFile({ name: 'PHOTO.PNG' })).toEqual({ allowed: true });
  });
});

describe('isExtractableArchive', () => {
  test('returns true for zip files', () => {
    expect(isExtractableArchive({ name: 'bundle.zip' })).toBe(true);
  });

  test('is case-insensitive for the zip extension', () => {
    expect(isExtractableArchive({ name: 'BUNDLE.ZIP' })).toBe(true);
  });

  test('returns false for non-zip files', () => {
    expect(isExtractableArchive({ name: 'archive.tar' })).toBe(false);
    expect(isExtractableArchive({ name: 'doc.pdf' })).toBe(false);
  });

  test('only declares zip as extractable', () => {
    expect(EXTRACTABLE_EXTENSIONS).toEqual(['.zip']);
  });
});

describe('ALLOWED_EXTENSIONS', () => {
  test('includes common document and image extensions', () => {
    expect(ALLOWED_EXTENSIONS).toContain('.pdf');
    expect(ALLOWED_EXTENSIONS).toContain('.png');
    expect(ALLOWED_EXTENSIONS).toContain('.docx');
  });
});
