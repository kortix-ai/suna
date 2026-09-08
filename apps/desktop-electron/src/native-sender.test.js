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
    const { event, contents } = sender(`${origin}/projects/project-1`);
    expect(isTrustedAppSender(event, contents, `${origin}/projects`)).toBe(
      true,
    );
  });

  test('rejects another window at the configured origin', () => {
    const { event } = sender('https://kortix.com/projects');
    const { contents } = sender('https://kortix.com/projects');
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
  });

  test('rejects child frames even at the configured origin', () => {
    const { event, contents } = sender('https://kortix.com/projects');
    event.senderFrame = { url: 'https://kortix.com/projects' };
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
  });

  test('rejects a frame that has navigated or been destroyed', () => {
    const { event, contents } = sender('https://kortix.com/projects');
    event.senderFrame = null;
    expect(isTrustedAppSender(event, contents, 'https://kortix.com')).toBe(
      false,
    );
    expect(isTrustedAppSender(event, undefined, 'https://kortix.com')).toBe(
      false,
    );
  });

  test.each([
    'https://preview.kortix.com/projects',
    'https://kortix.com.attacker.test/projects',
    'https://kortix.com@attacker.test/projects',
    'http://kortix.com/projects',
    'https://kortix.com:8443/projects',
    'file://kortix.com/projects',
    'blob:https://kortix.com/id',
    'not a URL',
  ])('rejects other origins and protocols: %s', (url) => {
    const { event, contents } = sender(url);
    expect(
      isTrustedAppSender(event, contents, 'https://kortix.com/projects'),
    ).toBe(false);
  });

  test('rejects a stale frontend after its configured URL changes', () => {
    const { event, contents } = sender('https://dev.kortix.com/projects');
    expect(
      isTrustedAppSender(event, contents, 'https://kortix.com/projects'),
    ).toBe(false);
  });
});
