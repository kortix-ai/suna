import { describe, expect, test } from 'bun:test';

import {
  PROMPT_MAX_PARTS,
  PROMPT_PARTS_MAX_BYTES,
  flattenPromptText,
  sanitizeInboxPromptParts,
} from './prompt-parts';

describe('sanitizeInboxPromptParts', () => {
  test('accepts an opaque staged attachment without URL or caller metadata', () => {
    expect(sanitizeInboxPromptParts([
      { type: 'file', attachment_id: '123e4567-e89b-42d3-a456-426614174000' },
    ])).toEqual({ parts: [
      { type: 'file', attachment_id: '123e4567-e89b-42d3-a456-426614174000' },
    ] });
  });
  // The 20-file cap belongs to staged attachment handles. A CLI or SDK prompt
  // of legacy data-URL file parts keeps the part and byte caps it always had.
  test('admits 25 legacy data-URL file parts', () => {
    const parts = Array.from({ length: 25 }, (_, index) => ({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,AAAA',
      filename: `shot-${index}.png`,
    }));
    const result = sanitizeInboxPromptParts(parts);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.parts).toHaveLength(25);
  });

  test('refuses 21 attachment handles', () => {
    const parts = Array.from({ length: 21 }, (_, index) => ({
      type: 'file',
      attachment_id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
    }));
    expect(sanitizeInboxPromptParts(parts)).toEqual({
      error: 'attachments supports at most 20 files',
    });
  });

  test('treats attachment_id: null as an absent field', () => {
    expect(
      sanitizeInboxPromptParts([
        {
          type: 'file',
          attachment_id: null,
          mime: 'image/png',
          url: 'data:image/png;base64,AAAA',
          filename: 'shot.png',
        },
      ]),
    ).toEqual({
      parts: [
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'shot.png' },
      ],
    });
  });

  test('refuses an attachment_id that is not a UUID', () => {
    expect(
      sanitizeInboxPromptParts([{ type: 'file', attachment_id: 'not-a-uuid' }]),
    ).toEqual({ error: 'attachment_id must be a UUID' });
  });

  test('keeps the known fields of text and file parts, drops everything else', () => {
    const result = sanitizeInboxPromptParts([
      { type: 'text', text: 'hello', evil: 'dropped' },
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,AAAA',
        filename: 'shot.png',
        source: { kind: 'upload' },
      },
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.parts).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,AAAA',
        filename: 'shot.png',
        source: { kind: 'upload' },
      },
    ]);
  });

  test('an unknown part type collapses to text — same repair POST /prompts always made', () => {
    const result = sanitizeInboxPromptParts([{ type: 'weird', text: 'kept' }]);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.parts[0]).toEqual({ type: 'text', text: 'kept' });
  });

  test('refuses an empty list and one past the part cap', () => {
    expect(sanitizeInboxPromptParts([])).toMatchObject({ error: expect.stringContaining('1..') });
    const many = Array.from({ length: PROMPT_MAX_PARTS + 1 }, () => ({
      type: 'text',
      text: 'x',
    }));
    expect(sanitizeInboxPromptParts(many)).toMatchObject({
      error: expect.stringContaining(String(PROMPT_MAX_PARTS)),
    });
  });

  test('refuses parts with no content at all', () => {
    // A prompt that flattens to nothing and carries no non-text part is a row
    // the drain would deliver as an empty message.
    expect(sanitizeInboxPromptParts([{ type: 'text', text: '   ' }])).toMatchObject({
      error: expect.stringContaining('text'),
    });
  });

  test('a non-text part with no text is content enough', () => {
    const result = sanitizeInboxPromptParts([
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'a.png' },
    ]);
    expect('error' in result).toBe(false);
  });

  test('accepts a staged ZIP data URL for runtime materialization', () => {
    expect(
      sanitizeInboxPromptParts([
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ]),
    ).toEqual({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    });
  });

  test('rejects a remote ZIP before it can poison model history', () => {
    expect(
      sanitizeInboxPromptParts([
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'https://files.example.test/bundle.zip',
        },
      ]),
    ).toEqual({
      error: 'file "bundle.zip" must be uploaded before it can be sent',
    });
  });

  test('rejects a MIME mismatch inside a staged data URL', () => {
    expect(
      sanitizeInboxPromptParts([
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:text/plain;base64,SGVsbG8=',
        },
      ]),
    ).toEqual({ error: 'file "bundle.zip" has inconsistent MIME metadata' });
  });

  test('rejects malformed base64 before admitting a staged non-native file', () => {
    for (const url of [
      'data:application/zip;base64,%%%= ',
      'data:application/zip;base64,UEs=DBA=',
      'data:application/zip;base64,UEsDBA==junk',
    ]) {
      expect(
        sanitizeInboxPromptParts([
          {
            type: 'file',
            mime: 'application/zip',
            filename: 'bundle.zip',
            url,
          },
        ]),
      ).toEqual({ error: 'file "bundle.zip" has malformed staged data' });
    }
  });

  test('stores canonical MIME and data URL values after accepting surrounding whitespace', () => {
    expect(
      sanitizeInboxPromptParts([
        {
          type: 'file',
          mime: '  application/zip  ',
          filename: 'bundle.zip',
          url: '  data:application/zip;base64,UEsDBA==  ',
        },
      ]),
    ).toEqual({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    });
  });

  test('caps the serialized payload — a durable row is a Postgres row, not a blob store', () => {
    // One oversized data-URL part. The cap exists so a first-prompt attachment
    // can ride the inbox as a data URL while an unbounded upload cannot wedge
    // the queue table.
    const huge = 'data:application/octet-stream;base64,' + 'A'.repeat(PROMPT_PARTS_MAX_BYTES);
    const result = sanitizeInboxPromptParts([
      { type: 'file', mime: 'application/octet-stream', url: huge, filename: 'big.bin' },
    ]);
    expect(result).toMatchObject({ error: expect.stringContaining('large') });
  });
});

describe('flattenPromptText', () => {
  test('joins text parts and ignores the rest', () => {
    expect(
      flattenPromptText([
        { type: 'text', text: 'a' },
        { type: 'file' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
});

// A native file staged as a data: URL is parsed at the door. Over the inline
// budget the drain materializes it, and a malformed one that slipped past the
// sanitizer failed at every drain instead of as a 400 here (review, 2026-09-05).
test('a malformed staged native image is refused at the door', () => {
  const out = sanitizeInboxPromptParts([
    { type: 'text', text: 'hi' },
    { type: 'file', mime: 'image/jpeg', filename: 'p.jpg', url: 'data:image/jpeg;base64,not*base64' },
  ]);
  expect('error' in out).toBe(true);
});

test('a native image that is a remote URL is still admitted', () => {
  const out = sanitizeInboxPromptParts([
    { type: 'text', text: 'hi' },
    { type: 'file', mime: 'image/jpeg', filename: 'p.jpg', url: 'https://box.test/p.jpg' },
  ]);
  expect('error' in out).toBe(false);
});

test('accepts stored non-native files and rejects malformed private references', () => {
  const url = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
  const file = { type: 'file' as const, filename: 'notes.txt', mime: 'text/plain', url };
  expect(sanitizeInboxPromptParts([file])).toEqual({ parts: [file] });
  expect(sanitizeInboxPromptParts([{ ...file, url: url + '/../private' }])).toHaveProperty('error');
});
