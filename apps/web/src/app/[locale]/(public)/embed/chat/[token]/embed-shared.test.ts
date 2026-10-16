import { PublicSessionShareError, type PublicSessionTranscript } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  embedFrameClasses,
  loadEmbedTranscript,
  parseEmbedLayout,
  type EmbedLayout,
} from './embed-shared';

describe('parseEmbedLayout', () => {
  test('accepts the three shipped layouts', () => {
    for (const layout of ['inline', 'panel', 'modal'] as const) {
      expect(parseEmbedLayout(layout)).toBe(layout);
    }
  });

  test('is case-insensitive', () => {
    expect(parseEmbedLayout('PANEL')).toBe('panel');
    expect(parseEmbedLayout('Modal')).toBe('modal');
  });

  test('anything else falls back to inline, the readable default', () => {
    expect(parseEmbedLayout('sidebar')).toBe('inline');
    expect(parseEmbedLayout('')).toBe('inline');
    expect(parseEmbedLayout(undefined)).toBe('inline');
    expect(parseEmbedLayout(null)).toBe('inline');
    expect(parseEmbedLayout(42)).toBe('inline');
  });
});

describe('embedFrameClasses', () => {
  test('every layout keeps a definite viewport height so the scroll box resolves', () => {
    for (const layout of ['inline', 'panel', 'modal'] as const) {
      expect(embedFrameClasses(layout).root).toContain('h-dvh');
      expect(embedFrameClasses(layout).scroll).toContain('h-full');
    }
  });

  test('inline centers a readable column, like the share page', () => {
    const frame = embedFrameClasses('inline');
    expect(frame.column).toContain('max-w-2xl');
    expect(frame.column).toContain('mx-auto');
  });

  test('panel fills a narrow sidebar edge to edge with tighter spacing', () => {
    const frame = embedFrameClasses('panel');
    expect(frame.column).not.toContain('max-w-2xl');
    expect(frame.column).not.toContain('mx-auto');
    expect(frame.column).toContain('py-4');
  });

  test('modal draws one card boundary inside the frame', () => {
    const frame = embedFrameClasses('modal');
    expect(frame.scroll).toContain('rounded-lg');
    expect(frame.scroll).toContain('border');
    expect(frame.root).toContain('p-3');
  });
});

describe('loadEmbedTranscript', () => {
  function transcript(overrides: Partial<PublicSessionTranscript> = {}): PublicSessionTranscript {
    return {
      available: true,
      reason: null,
      opencode_session_id: 'ses_synthetic',
      message_count: 1,
      messages: [],
      ...overrides,
    };
  }

  test('a live read lands on ready', async () => {
    const result = await loadEmbedTranscript(async () => transcript(), 'kps_token');
    expect(result).toEqual({ kind: 'ready', transcript: transcript() });
  });

  test('a transcript the API cannot serve reads as unavailable, not as an error', async () => {
    const result = await loadEmbedTranscript(
      async () => transcript({ available: false, reason: 'sandbox_stopped' }),
      'kps_token',
    );
    expect(result.kind).toBe('ready');
    expect(
      result.kind === 'ready' ? result.transcript.available : false,
    ).toBe(false);
  });

  test('404 and 410 are settled rejections carrying their status', async () => {
    for (const status of [404, 410]) {
      const result = await loadEmbedTranscript(
        async () => {
          throw new PublicSessionShareError('Share link revoked', status);
        },
        'kps_token',
      );
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' ? result.loadError?.status : 0).toBe(status);
    }
  });

  test('a network failure reports a null status, never the raw throw', async () => {
    const result = await loadEmbedTranscript(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      'kps_token',
    );
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' ? result.loadError?.status : 1).toBeNull();
  });

  test('no server-side reader (no backend URL) is the generic error, not a fetch', async () => {
    const result = await loadEmbedTranscript(null, 'kps_token');
    expect(result).toEqual({ kind: 'error', loadError: null });
  });
});
