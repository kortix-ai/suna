import { describe, expect, test } from 'bun:test';
import type { SessionLogMessage, SessionLogTurn } from '@kortix/sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TurnFullText, formatTextSize, harnessName, hasOutOfContext } from './session-history';

describe('session history helpers', () => {
  test('a harness id reads as its product name; an unknown id shows as it is', () => {
    expect(harnessName('opencode')).toBe('OpenCode');
    expect(harnessName('pi')).toBe('pi');
    expect(harnessName('codex')).toBe('codex');
  });

  test('a text size rounds up to whole kB, and to tenths of a MB from 1 MB on', () => {
    expect(formatTextSize(300_000, 'en')).toBe('293 kB');
    expect(formatTextSize(16 * 1024 + 1, 'en')).toBe('17 kB');
    expect(formatTextSize(3 * 1024 * 1024 + 1, 'en')).toBe('3.1 MB');
    expect(formatTextSize(300_000, 'de')).toBe('293 kB');
  });

  test('the toggle has work only when a message out of context is not streaming', () => {
    const m = (in_context: boolean, status: SessionLogMessage['status'] = 'complete') => ({ in_context, status }) as SessionLogMessage;
    expect(hasOutOfContext(undefined)).toBe(false);
    expect(hasOutOfContext([m(true), m(false, 'streaming')])).toBe(false);
    expect(hasOutOfContext([m(true), m(false, 'error')])).toBe(true);
  });
});

describe('the full-text control', () => {
  const REF = 'kortix-attachment://11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333';
  const turn = (bytes: number) =>
    ({ id: 'u', user: { blocks: [{ type: 'text', id: 't', text: 'preview', ref: REF, bytes }] }, assistant: [] }) as unknown as SessionLogTurn;
  const html = (bytes: number) => renderToStaticMarkup(createElement(TurnFullText, { turn: turn(bytes), state: 'idle', onLoad: () => {} }));

  test('up to 1 MB the text is shown inline; above, it is offered as a download', () => {
    expect(html(1024 * 1024)).toContain('Show full text (1 MB)');
    expect(html(1024 * 1024 + 1)).toContain('Download full text (1.1 MB)');
  });

  test('a turn with no text stored by reference renders nothing', () => {
    const plain = { id: 'p', user: { blocks: [{ type: 'text', id: 't', text: 'hi' }] }, assistant: [] } as unknown as SessionLogTurn;
    expect(renderToStaticMarkup(createElement(TurnFullText, { turn: plain, state: 'idle', onLoad: () => {} }))).toBe('');
  });
});
