import { describe, expect, test } from 'bun:test';

import {
  PROMPT_MAX_PARTS,
  PROMPT_PARTS_MAX_BYTES,
  flattenPromptText,
  sanitizeInboxPromptParts,
} from './prompt-parts';

describe('sanitizeInboxPromptParts', () => {
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
