import { describe, expect, test } from 'bun:test';

import { identityMessage, isInsideExtensionPanel } from './extension-panel-identity';

const EXT = 'chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/';

describe('extension panel identity', () => {
  test('detects only a framed page whose referrer is the Kortix extension', () => {
    expect(isInsideExtensionPanel(EXT + 'sidepanel.html', true)).toBe(true);
    expect(isInsideExtensionPanel(EXT + 'sidepanel.html', false)).toBe(false);
    expect(isInsideExtensionPanel('chrome-extension://otherextensionid/x.html', true)).toBe(false);
    expect(isInsideExtensionPanel('https://example.com/', true)).toBe(false);
    expect(isInsideExtensionPanel('', true)).toBe(false);
  });

  test('the message carries the user id and email', () => {
    expect(identityMessage({ id: 'u1', email: 'a@example.test' })).toEqual({
      type: 'kortix.identity', userId: 'u1', email: 'a@example.test',
    });
    expect(identityMessage({ id: 'u1' }).email).toBe('');
  });
});
