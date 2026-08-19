import { describe, expect, test } from 'bun:test';

import { attachmentMime, extensionOf, isImageExtension, mimeForFilename } from './attachment-mime';

describe('attachment mime', () => {
  test('the browser type always wins', () => {
    expect(attachmentMime('image/png', 'weird.name')).toBe('image/png');
    // Even when it disagrees with the extension — the browser sniffed the bytes.
    expect(attachmentMime('text/plain', 'shot.png')).toBe('text/plain');
  });

  test('an empty type falls back to the extension', () => {
    // A browser is free to hand over `type: ''`, and does for `.md`, `.csv` and
    // some platforms' `.png`. That used to become `application/octet-stream`,
    // which the transcript renders as a generic file icon.
    expect(attachmentMime('', 'shot.png')).toBe('image/png');
    expect(attachmentMime(undefined, 'notes.md')).toBe('text/markdown');
    expect(attachmentMime('   ', 'rows.csv')).toBe('text/csv');
  });

  test('an unknown extension is honestly unknown', () => {
    expect(attachmentMime('', 'archive.qqq')).toBe('application/octet-stream');
    expect(attachmentMime('', 'README')).toBe('application/octet-stream');
    expect(mimeForFilename('archive.qqq')).toBeUndefined();
  });

  test('a dotfile has no extension to sniff', () => {
    // `split('.').pop()` hands back the whole name, which would make `.env`
    // look like an `env` file and `key` like a Keynote deck.
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('key')).toBe('');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('/workspace/uploads/a.PNG')).toBe('png');
  });

  test('the image test is the one the composer and the transcript share', () => {
    expect(isImageExtension('shot.PNG')).toBe(true);
    expect(isImageExtension('photo.heic')).toBe(true);
    expect(isImageExtension('notes.md')).toBe(false);
  });
});
