import { describe, expect, test } from 'bun:test';
import { ACT_HANDOFF_MS, contextTab, freshAct, isReadableUrl, MAX_READ_TABS, panelRequest, toPanelTab } from './panel-bridge';

const frame = {} as Window;
const web = 'https://kortix.com';
const msg = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: web, source: frame, data, ...over });

describe('panel page channel', () => {
  test('accepts each request from the panel frame', () => {
    expect(panelRequest(msg({ type: 'kortix.panel.hello' }), web, frame)).toEqual({ type: 'kortix.panel.hello' });
    expect(panelRequest(msg({ type: 'kortix.panel.tabs', requestId: 'r1' }), web, frame)).toEqual({ type: 'kortix.panel.tabs', requestId: 'r1' });
    expect(panelRequest(msg({ type: 'kortix.panel.read', requestId: 'r2', tabIds: [4, 4, 9] }), web, frame))
      .toEqual({ type: 'kortix.panel.read', requestId: 'r2', tabIds: [4, 9] });
    expect(panelRequest(msg({ type: 'kortix.panel.act', tabId: 7 }), web, frame)).toEqual({ type: 'kortix.panel.act', tabId: 7 });
    expect(panelRequest(msg({ type: 'kortix.panel.capture', requestId: 'c1' }), web, frame)).toEqual({ type: 'kortix.panel.capture', requestId: 'c1' });
    expect(panelRequest(msg({ type: 'kortix.panel.route', path: '/projects/p/sessions/s', sessionId: 's' }), web, frame))
      .toEqual({ type: 'kortix.panel.route', path: '/projects/p/sessions/s', sessionId: 's' });
    expect(panelRequest(msg({ type: 'kortix.panel.route', path: '/panel' }), web, frame)).toEqual({ type: 'kortix.panel.route', path: '/panel' });
  });

  test('ignores another origin, another window, and unknown messages', () => {
    const hello = { type: 'kortix.panel.hello' };
    expect(panelRequest(msg(hello, { origin: 'https://evil.test' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg(hello, { origin: 'https://kortix.com.evil.test' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg(hello, { source: {} }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.other' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg(null), web, frame)).toBeUndefined();
  });

  test('refuses malformed fields', () => {
    expect(panelRequest(msg({ type: 'kortix.panel.tabs' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.capture' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.read', requestId: 'r', tabIds: [] }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.read', requestId: 'r', tabIds: [1.5] }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.read', requestId: 'r', tabIds: [-1] }), web, frame)).toBeUndefined();
    const tooMany = Array.from({ length: MAX_READ_TABS + 1 }, (_, i) => i + 1);
    expect(panelRequest(msg({ type: 'kortix.panel.read', requestId: 'r', tabIds: tooMany }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.act', tabId: '7' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.route', path: 'https://evil.test/x' }), web, frame)).toBeUndefined();
    expect(panelRequest(msg({ type: 'kortix.panel.route', path: '/x', sessionId: 5 }), web, frame)).toEqual({ type: 'kortix.panel.route', path: '/x' });
  });
});

describe('tabs', () => {
  test('web pages are readable; Chrome pages and the Web Store are not', () => {
    expect(isReadableUrl('https://example.com/a')).toBe(true);
    expect(isReadableUrl('http://localhost:3000/')).toBe(true);
    expect(isReadableUrl('chrome://settings')).toBe(false);
    expect(isReadableUrl('chrome-extension://abc/welcome.html')).toBe(false);
    expect(isReadableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isReadableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isReadableUrl('https://chrome.google.com/search')).toBe(true);
  });

  test('a tab needs an id and a url; the title falls back to the url', () => {
    expect(toPanelTab({ id: 3, url: 'https://example.com/', title: '' } as chrome.tabs.Tab))
      .toEqual({ id: 3, title: 'https://example.com/', url: 'https://example.com/', readable: true });
    expect(toPanelTab({ url: 'https://example.com/' } as chrome.tabs.Tab)).toBeUndefined();
    expect(toPanelTab({ id: 3 } as chrome.tabs.Tab)).toBeUndefined();
  });

  test('the panel is about the active tab; as a tab itself, about the one used last before it', () => {
    const tabs = [
      { id: 1, active: false, lastAccessed: 30 },
      { id: 2, active: true, lastAccessed: 50 },
      { id: 3, active: false, lastAccessed: 40 },
    ];
    expect(contextTab(tabs)?.id).toBe(2);
    expect(contextTab(tabs, 9)?.id).toBe(2);
    expect(contextTab(tabs, 2)?.id).toBe(3);
    expect(contextTab([{ id: 2, active: true }], 2)).toBeUndefined();
    expect(contextTab([])).toBeUndefined();
  });

  test('an Act send hands its tab over only while it is fresh', () => {
    expect(freshAct({ tabId: 5, at: 1_000 }, 1_000 + ACT_HANDOFF_MS - 1)).toBe(5);
    expect(freshAct({ tabId: 5, at: 1_000 }, 1_000 + ACT_HANDOFF_MS)).toBeUndefined();
    expect(freshAct(undefined, 1_000)).toBeUndefined();
  });
});
