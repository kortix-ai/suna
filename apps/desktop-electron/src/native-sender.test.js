const { describe, expect, test } = require('bun:test');
const { isTrustedAppSender } = require('./native-sender');

function sender(url) {
  const frame = { url };
  const contents = { mainFrame: frame, getURL: () => url };
  return { event: { sender: contents, senderFrame: frame }, contents };
}

describe('native command sender', () => {
  test.each([
    'https://kortix.com',
    'https://dev.kortix.com',
    'http://localhost:16200',
    'https://app.example.test',
  ])('trusts the configured frontend main frame: %s', (origin) => {
    const { event, contents } = sender(`${origin}/workspaces/project-1`);
    expect(isTrustedAppSender(event, contents, `${origin}/workspaces`)).toBe(
      true,
    );
  });

  test('rejects another window at the configured origin', () => {
    const { event } = sender('https://kortix.com/workspaces');
    const { contents } = sender('https://kortix.com/workspaces');
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
  });

  test('rejects child frames even at the configured origin', () => {
    const { event, contents } = sender('https://kortix.com/workspaces');
    event.senderFrame = { url: 'https://kortix.com/workspaces' };
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
  });

  test('rejects a frame that has navigated or been destroyed', () => {
    const { event, contents } = sender('https://kortix.com/workspaces');
    event.senderFrame = null;
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
    expect(isTrustedAppSender(event, undefined, 'https://kortix.com')).toBe(
      false,
    );
  });

  test.each([
    'https://preview.kortix.com/workspaces',
    'https://kortix.com.attacker.test/workspaces',
    'https://kortix.com@attacker.test/workspaces',
    'http://kortix.com/workspaces',
    'https://kortix.com:8443/workspaces',
    'file://kortix.com/workspaces',
    'blob:https://kortix.com/id',
    'not a URL',
  ])('rejects other origins and protocols: %s', (url) => {
    const { event, contents } = sender(url);
    expect(
      isTrustedAppSender(event, contents, 'https://kortix.com/workspaces'),
    ).toBe(false);
  });

  test('rejects a stale frontend after its configured URL changes', () => {
    const { event, contents } = sender('https://dev.kortix.com/workspaces');
    expect(
      isTrustedAppSender(event, contents, 'https://kortix.com/workspaces'),
    ).toBe(false);
  });
});
