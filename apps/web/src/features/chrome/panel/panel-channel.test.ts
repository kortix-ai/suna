import { describe, expect, test } from 'bun:test';

import { EXTENSION_ORIGIN } from '@/lib/supabase/panel-cookies';

import { readExtensionMessage, sessionIdFromPath } from './panel-channel';

const parent = {};
const from = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({
  origin: EXTENSION_ORIGIN,
  source: parent,
  data,
  ...over,
});
const tab = { id: 4, title: 'Pricing', url: 'https://example.com/pricing', readable: true };

describe('panel channel: messages from the extension', () => {
  test('reads the active tab, a right-click context and both results', () => {
    expect(readExtensionMessage(from({ type: 'kortix.panel.tab', tab }), parent)).toEqual({ type: 'kortix.panel.tab', tab });
    expect(readExtensionMessage(from({ type: 'kortix.panel.tab', tab: null }), parent)).toEqual({
      type: 'kortix.panel.tab',
      tab: null,
    });
    expect(readExtensionMessage(from({ type: 'kortix.panel.context', tab, quote: '  SSO is included. ' }), parent)).toEqual({
      type: 'kortix.panel.context',
      tab,
      quote: 'SSO is included.',
    });
    expect(
      readExtensionMessage(from({ type: 'kortix.panel.tabs.result', requestId: 'r1', tabs: [tab, { id: 'x' }] }), parent),
    ).toEqual({ type: 'kortix.panel.tabs.result', requestId: 'r1', tabs: [tab] });
    expect(
      readExtensionMessage(
        from({
          type: 'kortix.panel.read.result',
          requestId: 'r2',
          pages: [
            { tabId: 4, title: 'Pricing', url: tab.url, text: 'Team $29', truncated: false },
            { tabId: 9, error: 'unreadable' },
            { tabId: 'bad' },
          ],
        }),
        parent,
      ),
    ).toEqual({
      type: 'kortix.panel.read.result',
      requestId: 'r2',
      pages: [
        { tabId: 4, title: 'Pricing', url: tab.url, text: 'Team $29', truncated: false },
        { tabId: 9, error: 'unreadable' },
      ],
    });
  });

  test('a tab is readable only when the extension says so', () => {
    const { readable: _r, ...rest } = tab;
    expect(readExtensionMessage(from({ type: 'kortix.panel.tab', tab: rest }), parent)).toEqual({
      type: 'kortix.panel.tab',
      tab: { ...rest, readable: false },
    });
  });

  test('ignores another origin, another window, and unknown or malformed messages', () => {
    const message = { type: 'kortix.panel.tab', tab };
    expect(readExtensionMessage(from(message, { origin: 'https://evil.test' }), parent)).toBeNull();
    expect(readExtensionMessage(from(message, { origin: 'chrome-extension://otherextensionid' }), parent)).toBeNull();
    expect(readExtensionMessage(from(message, { source: {} }), parent)).toBeNull();
    expect(readExtensionMessage(from({ type: 'kortix.panel.session', tokenHash: 'x' }), parent)).toBeNull();
    expect(readExtensionMessage(from('kortix.panel.tab'), parent)).toBeNull();
    expect(readExtensionMessage(from({ type: 'kortix.panel.tabs.result', tabs: [] }), parent)).toBeNull();
    expect(readExtensionMessage(from({ type: 'kortix.panel.read.result', requestId: 'r', pages: 'x' }), parent)).toBeNull();
  });
});

describe('panel channel: routes', () => {
  test('finds the session a path shows', () => {
    expect(sessionIdFromPath('/projects/p1/sessions/s1')).toBe('s1');
    expect(sessionIdFromPath('/de/projects/p1/sessions/s1/files')).toBe('s1');
    expect(sessionIdFromPath('/projects/p1')).toBeUndefined();
    expect(sessionIdFromPath('/panel')).toBeUndefined();
  });
});
