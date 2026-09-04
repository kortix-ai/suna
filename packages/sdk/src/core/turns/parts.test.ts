import { describe, expect, test } from 'bun:test';

import { isAttachment, splitUserParts } from './parts';

const text = { id: 'part_text', type: 'text', text: 'Inspect this.' } as const;
const zip = {
  id: 'part_zip',
  type: 'file',
  mime: 'application/zip',
  filename: 'bundle.zip',
  url: 'data:application/zip;base64,UEsDBA==',
} as const;

describe('splitUserParts', () => {
  test('returns every file as a display attachment', () => {
    expect(splitUserParts([text, zip])).toEqual({
      attachments: [zip],
      stickyParts: [text],
    });
  });

  test('keeps isAttachment limited to model-native image and PDF parts', () => {
    expect(isAttachment(zip)).toBe(false);
    expect(
      isAttachment({ ...zip, mime: 'application/pdf', filename: 'report.pdf' }),
    ).toBe(true);
  });
});
