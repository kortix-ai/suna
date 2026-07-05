import { describe, expect, test } from 'bun:test';
import { PublicSessionShareError } from '@kortix/sdk/projects-client';
import { describeShareError, toShareLoadError, transcriptUnavailableMessage } from './share-load-error';

describe('toShareLoadError', () => {
  test('preserves the status from a PublicSessionShareError', () => {
    const err = new PublicSessionShareError('Share link revoked', 410);
    expect(toShareLoadError(err)).toEqual({ status: 410, message: 'Share link revoked' });
  });

  test('reports a null status for a plain Error', () => {
    expect(toShareLoadError(new Error('network down'))).toEqual({ status: null, message: 'network down' });
  });

  test('falls back to a generic message for a non-Error throw', () => {
    expect(toShareLoadError('boom')).toEqual({ status: null, message: 'Failed to load share' });
  });
});

describe('describeShareError', () => {
  test('404 reads as not found', () => {
    expect(describeShareError({ status: 404, message: 'Share link not found' }).title).toBe('Share Not Found');
  });

  test('410 reads as expired/revoked', () => {
    expect(describeShareError({ status: 410, message: 'Share link revoked' }).title).toBe('Share Link Expired');
  });

  test('503 reads as not ready yet, distinct from a hard error', () => {
    const result = describeShareError({ status: 503, message: 'Sandbox is not ready' });
    expect(result.title).toBe('Session Not Ready');
    expect(result.description).toContain('Try again');
  });

  test('an unknown status falls back to a generic error using the message', () => {
    const result = describeShareError({ status: 500, message: 'boom' });
    expect(result.title).toBe('Error Loading Share');
    expect(result.description).toBe('boom');
  });

  test('a null error still renders a generic fallback', () => {
    expect(describeShareError(null).title).toBe('Error Loading Share');
  });
});

describe('transcriptUnavailableMessage', () => {
  test('includes the reason when present', () => {
    expect(transcriptUnavailableMessage('OpenCode is not ready in the sandbox yet')).toBe(
      'Conversation temporarily unavailable — OpenCode is not ready in the sandbox yet.',
    );
  });

  test('falls back to a generic message with no reason', () => {
    expect(transcriptUnavailableMessage(null)).toBe('Conversation temporarily unavailable.');
  });
});
