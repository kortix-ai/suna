import { describe, expect, test } from 'bun:test';
import { safeTelegramFilePath } from './file-proxy';

/** The only caller-influenced fragment of the download URL — everything that
 *  could escape `${base}/file/bot${token}/…` must be rejected. */
describe('safeTelegramFilePath', () => {
  test('accepts the shapes Telegram actually returns', () => {
    expect(safeTelegramFilePath('documents/file_12.pdf')).toBe(true);
    expect(safeTelegramFilePath('photos/file_3 (1).jpg')).toBe(true);
    expect(safeTelegramFilePath('voice/file_7.oga')).toBe(true);
  });

  test('rejects traversal, absolute paths, schemes, and query/fragment tricks', () => {
    expect(safeTelegramFilePath('../secrets')).toBe(false);
    expect(safeTelegramFilePath('documents/../../etc/passwd')).toBe(false);
    expect(safeTelegramFilePath('/etc/passwd')).toBe(false);
    expect(safeTelegramFilePath('https://evil.example/x')).toBe(false);
    expect(safeTelegramFilePath('documents/file.pdf?x=1')).toBe(false);
    expect(safeTelegramFilePath('documents/file.pdf#frag')).toBe(false);
    expect(safeTelegramFilePath('doc\\file.pdf')).toBe(false);
    expect(safeTelegramFilePath('')).toBe(false);
    expect(safeTelegramFilePath('x'.repeat(600))).toBe(false);
  });
});
