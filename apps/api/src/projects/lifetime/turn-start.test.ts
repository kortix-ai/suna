/**
 * BOUNDED SANDBOX LIFETIME — the turn-start classifier, enumerated.
 *
 * Failure mode #1 in the design is "a new turn-start path appears that the
 * classifier does not recognise, and a box is killed mid-turn". The mitigation
 * is that this is ONE pure function with an exhaustive test: adding a tenth
 * path is a one-line reviewed change, and deleting a ninth breaks a named test.
 */
import { describe, expect, test } from 'bun:test';
import { isTurnStartRequest, unwrapProxyPrefix } from './turn-start';

const AGENT = 8000;
const OPENCODE = 4096;

describe('isTurnStartRequest — the paths that START a turn', () => {
  test.each([
    ['prompt_async, the path every real client uses', AGENT, '/session/abc/prompt_async'],
    ['message, the synchronous blocking turn', AGENT, '/session/abc/message'],
    ['command, a real billable turn', AGENT, '/session/abc/command'],
    ['summarize, likewise', AGENT, '/session/abc/summarize'],
    ['a trailing slash', AGENT, '/session/abc/prompt_async/'],
    ['a query string', AGENT, '/session/abc/prompt_async?stream=1'],
    ['the ACP envelope route', AGENT, '/kortix/acp'],
    ['ACP with a runtime instance suffix', AGENT, '/kortix/acp/runtime-1'],
    ['Daytona un-rerouted :4096', OPENCODE, '/session/abc/prompt_async'],
    ['in-box /proxy/<port> nesting', AGENT, '/proxy/4096/session/abc/prompt_async'],
  ])('%s', (_label, port, path) => {
    expect(isTurnStartRequest(port, 'POST', path)).toBe(true);
  });

  test('is case-insensitive on the method, since clients are not consistent', () => {
    expect(isTurnStartRequest(AGENT, 'post', '/session/abc/prompt_async')).toBe(true);
  });
});

describe('isTurnStartRequest — what must NOT count', () => {
  test.each([
    ['a GET of the same path is a read, not a turn', AGENT, 'GET', '/session/abc/prompt_async'],
    [
      'listing sessions — the passive poll that must not extend anything',
      AGENT,
      'POST',
      '/session',
    ],
    ['the event stream', AGENT, 'GET', '/event'],
    ['a health probe', AGENT, 'POST', '/kortix/health'],
    ['an arbitrary user app port', 3000, 'POST', '/session/abc/prompt_async'],
    ['a nested path that only LOOKS like a prompt', AGENT, 'POST', '/x/session/abc/message'],
    ['a sibling path with a shared prefix', AGENT, 'POST', '/session/abc/prompt_asyncx'],
  ])('%s', (_label, port, method, path) => {
    expect(isTurnStartRequest(port, method, path)).toBe(false);
  });

  test('the session id segment cannot swallow a slash and forge a match', () => {
    // `[^/]+` rather than `.+` — otherwise /session/a/b/prompt_async, which is
    // not a real opencode route, would classify as a turn start.
    expect(isTurnStartRequest(AGENT, 'POST', '/session/a/b/prompt_async')).toBe(false);
  });
});

describe('unwrapProxyPrefix', () => {
  test('strips exactly one dynamic-port prefix and leaves the rest alone', () => {
    expect(unwrapProxyPrefix('/proxy/4096/session/a/message')).toBe('/session/a/message');
    expect(unwrapProxyPrefix('/proxy/abc/session/a/message')).toBe('/proxy/abc/session/a/message');
    expect(unwrapProxyPrefix('/session/a/message')).toBe('/session/a/message');
  });
});
