const { describe, expect, test } = require('bun:test');

const { createDeepLinkInbox } = require('./deep-link-inbox');

function harness({ canOpen = true } = {}) {
  const delivered = [];
  let opened = 0;
  const inbox = createDeepLinkInbox({
    deliver: (url) => delivered.push(url),
    canOpenWindow: () => canOpen,
    openWindow: () => { opened += 1; },
  });
  return { inbox, delivered, opened: () => opened };
}

describe('deep link inbox', () => {
  test('a link with a loaded window is delivered at once', () => {
    const h = harness();
    h.inbox.windowLoaded();
    h.inbox.receive('kortix://auth/callback?code=1');
    expect(h.delivered).toEqual(['kortix://auth/callback?code=1']);
    expect(h.opened()).toBe(0);
  });

  test('macOS, window closed: the link opens a window and is delivered when it loads', () => {
    const h = harness();
    h.inbox.windowLoaded();
    h.inbox.windowClosed();
    h.inbox.receive('kortix://auth/callback?code=2');
    expect(h.delivered).toEqual([]);
    expect(h.opened()).toBe(1);
    h.inbox.windowLoaded();
    expect(h.delivered).toEqual(['kortix://auth/callback?code=2']);
    h.inbox.windowLoaded(); // a reload does not deliver the link twice
    expect(h.delivered).toHaveLength(1);
  });

  test('cold start: the link waits for the first load and opens no extra window', () => {
    const h = harness({ canOpen: false });
    h.inbox.receive('kortix://auth/callback?code=3');
    expect(h.opened()).toBe(0);
    expect(h.inbox.hasPending()).toBe(true);
    h.inbox.windowLoaded();
    expect(h.delivered).toEqual(['kortix://auth/callback?code=3']);
    expect(h.inbox.hasPending()).toBe(false);
  });

  test('the newest link wins while the window loads', () => {
    const h = harness({ canOpen: false });
    h.inbox.receive('kortix://auth/callback?code=old');
    h.inbox.receive('kortix://auth/callback?code=new');
    h.inbox.windowLoaded();
    expect(h.delivered).toEqual(['kortix://auth/callback?code=new']);
  });
});
