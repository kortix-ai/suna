import { describe, expect, test } from 'bun:test';

import { isAttachment, isStepPart, splitUserParts } from './parts';

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

describe('isStepPart', () => {
  test('is true for both step boundary parts and nothing else', () => {
    expect(isStepPart({ id: 'p1', type: 'step-start' })).toBe(true);
    expect(isStepPart({ id: 'p2', type: 'step-finish' })).toBe(true);
    expect(isStepPart(text)).toBe(false);
    expect(isStepPart({ id: 'p3', type: 'tool' })).toBe(false);
  });
});
