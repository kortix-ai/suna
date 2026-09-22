import { describe, expect, test } from 'bun:test';
import { clientAbortTarget } from './client-abort';

// Every client that stops a turn — web, mobile, SDK, CLI — does it with one
// OpenCode call through this proxy. It is the only place the control plane can
// learn that a stop was ASKED FOR before the turn ends.
describe('clientAbortTarget', () => {
  test('names the OpenCode session a client asked to abort', () => {
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/abort')).toBe('ses_root');
    expect(clientAbortTarget(8000, 'post', '/session/ses_root/abort/')).toBe('ses_root');
    expect(clientAbortTarget(8000, 'POST', '/session/ses%2Froot/abort')).toBe('ses/root');
  });

  test('is null for everything that is not that call', () => {
    expect(clientAbortTarget(8000, 'GET', '/session/ses_root/abort')).toBeNull();
    expect(clientAbortTarget(3000, 'POST', '/session/ses_root/abort')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/message')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session/ses_root/abort/after-tool')).toBeNull();
    // The daemon's OWN abort route is the control plane stopping a box, not a client.
    expect(clientAbortTarget(8000, 'POST', '/kortix/abort')).toBeNull();
    expect(clientAbortTarget(8000, 'POST', '/session//abort')).toBeNull();
  });

  test('a malformed escape is not an abort target', () => {
    expect(clientAbortTarget(8000, 'POST', '/session/%E0%A4%A/abort')).toBeNull();
  });
});
