import { testUiTranslator } from '@/i18n/test-translator';
import {
  PublicSessionShareError,
  type PublicSessionTranscript,
  type PublicSessionTranscriptMessage,
} from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  describeShareError,
  savedCopyTimestamp,
  toShareLoadError,
  visibleTranscriptMessages,
} from './public-transcript';

function message(
  role: string,
  text: string,
  created: string | null = null,
): PublicSessionTranscriptMessage {
  return {
    role,
    created,
    completed: null,
    text,
    tools: [],
    files: [],
    reasoning_omitted: false,
  };
}

function transcript(overrides: Partial<PublicSessionTranscript> = {}): PublicSessionTranscript {
  return {
    available: true,
    reason: null,
    opencode_session_id: 'ses_synthetic',
    message_count: 0,
    messages: [],
    ...overrides,
  };
}

describe('toShareLoadError', () => {
  test('keeps the HTTP status of a PublicSessionShareError', () => {
    const err = new PublicSessionShareError('Share link revoked', 410);
    expect(toShareLoadError(err)).toEqual({ status: 410, message: 'Share link revoked' });
  });

  test('reports a null status for a plain Error', () => {
    expect(toShareLoadError(new Error('network down'))).toEqual({
      status: null,
      message: 'network down',
    });
  });

  test('falls back to a generic message for a non-Error throw', () => {
    expect(toShareLoadError('boom')).toEqual({ status: null, message: 'Failed to load share' });
  });
});

describe('describeShareError', () => {
  test('404 reads as not found', () => {
    expect(
      describeShareError({ status: 404, message: 'x' }, testUiTranslator, 'Generic').title,
    ).toBe('Share Not Found');
  });

  test('410 reads as revoked or expired', () => {
    expect(
      describeShareError({ status: 410, message: 'x' }, testUiTranslator, 'Generic').title,
    ).toBe('Share Link Expired');
  });

  test('503 reads as not ready yet', () => {
    const result = describeShareError({ status: 503, message: 'x' }, testUiTranslator, 'Generic');
    expect(result.title).toBe('Session Not Ready');
    expect(result.description).toContain('Try again');
  });

  test('an unknown status uses the fixed generic description, never the API text', () => {
    const result = describeShareError(
      { status: 500, message: 'boom' },
      testUiTranslator,
      'Generic',
    );
    expect(result.title).toBe('Error Loading Share');
    expect(result.description).toBe('Generic');
  });

  test('a null error still renders the generic copy', () => {
    expect(describeShareError(null, testUiTranslator, 'Generic').title).toBe('Error Loading Share');
  });
});

describe('visibleTranscriptMessages', () => {
  test('drops messages with no text and keeps the server order', () => {
    const result = visibleTranscriptMessages(
      transcript({
        messages: [
          message('user', 'first', '2026-09-26T10:00:00Z'),
          message('assistant', '   ', '2026-09-26T10:00:01Z'),
          // A null timestamp must not move a message: the API already orders them.
          message('assistant', 'second', null),
          message('user', 'third', '2026-09-26T10:00:03Z'),
        ],
      }),
    );
    expect(result.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  test('returns nothing when the transcript is unavailable', () => {
    expect(
      visibleTranscriptMessages(
        transcript({ available: false, messages: [message('user', 'stale')] }),
      ),
    ).toEqual([]);
  });
});

describe('savedCopyTimestamp', () => {
  test('names the capture time of a saved transcript', () => {
    expect(
      savedCopyTimestamp(transcript({ source: 'mirror', captured_at: '2026-09-26T10:00:00Z' })),
    ).toBe('2026-09-26T10:00:00Z');
  });

  test('is null for a live read', () => {
    expect(savedCopyTimestamp(transcript({ source: 'live', captured_at: null }))).toBeNull();
  });

  test('is null for a saved transcript without a valid capture time', () => {
    expect(savedCopyTimestamp(transcript({ source: 'mirror', captured_at: null }))).toBeNull();
    expect(
      savedCopyTimestamp(transcript({ source: 'mirror', captured_at: 'not a date' })),
    ).toBeNull();
  });

  test('is null for an older API that sends no source', () => {
    expect(savedCopyTimestamp(transcript())).toBeNull();
  });
});
