import { describe, expect, mock, test } from 'bun:test';

mock.module('../http/auth', () => ({
  authenticatedFetch: async () => new Response('[]'),
  getAuthToken: async () => 'test-token',
}));

import { classifyPtyClose, getKortixPtyWebSocketUrl, sanitizePtyChunk } from './pty';

const BASE = 'https://api.example.com/v1/p/sbx_1/8000';

describe('getKortixPtyWebSocketUrl', () => {
  test('builds the wss attach url with the auth token', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/p/sbx_1/8000/kortix/pty/kpty_1/connect');
    expect(url.searchParams.get('token')).toBe('test-token');
    expect(url.searchParams.get('wake')).toBeNull();
  });

  // A parked sandbox refuses the upgrade with 503, which a browser can only
  // report as close code 1006 — so an attach that never says "this is a human
  // opening a terminal" loops forever against a box nothing will wake. Only a
  // user-initiated connect (first mount, "Reconnect now") carries `wake=1`;
  // automatic backoff retries must not, or polling would resurrect boxes.
  test('marks a user-initiated attach with wake=1', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE, { wake: true }));
    expect(url.searchParams.get('wake')).toBe('1');
    expect(url.searchParams.get('token')).toBe('test-token');
  });

  test('an explicit non-wake attach stays unmarked', async () => {
    const url = new URL(await getKortixPtyWebSocketUrl('kpty_1', BASE, { wake: false }));
    expect(url.searchParams.get('wake')).toBeNull();
  });
});

// ── classifyPtyClose / sanitizePtyChunk ────────────────────────────────────
//
// Both rules were written three times, once per host, with no SDK owner:
//   apps/web/src/features/session/pty-connection.ts:114   classifyPtyClose
//   apps/tui/src/features/terminal/pty-session.ts:71      ptyCloseAction
//   apps/cli/src/commands/sessions-shell.ts:28            sanitizePtyChunk
//   apps/tui/src/features/terminal/pty-session.ts:116     sanitizePtyChunk
// These cases are the UNION of what those three assert.

describe('classifyPtyClose', () => {
  test('replaces a daemon-side PTY that no longer exists even when the proxy reports 1000', () => {
    // The daemon's PTY registry is process-local. After a runtime restart an
    // old tab holds an id that no reconnect can ever resolve; the owner must
    // mint a new PTY.
    expect(classifyPtyClose({ code: 1000, reason: 'pty not found', hadError: false })).toBe(
      'replace',
    );
    expect(classifyPtyClose({ code: 1006, reason: 'PTY NOT FOUND', hadError: true })).toBe(
      'replace',
    );
  });

  test('leaves an intentional shell exit ended', () => {
    expect(classifyPtyClose({ code: 1000, reason: 'pty exited', hadError: false })).toBe('ended');
    expect(classifyPtyClose({ code: 1000, reason: 'pty exited (0)', hadError: false })).toBe(
      'ended',
    );
    expect(classifyPtyClose({ code: 1000, reason: '', hadError: false })).toBe('ended');
    expect(classifyPtyClose({ code: 1000, reason: '  Pty Exited (1) ', hadError: false })).toBe(
      'ended',
    );
  });

  test('reconnects transport loss regardless of proxy close-code normalization', () => {
    // An intermediary that rewrites the code to 1000 is the historical
    // behaviour behind the user-visible failure — the REASON and the error flag
    // are what still carry the truth.
    expect(classifyPtyClose({ code: 1000, reason: 'upstream error', hadError: true })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1011, reason: 'upstream error', hadError: true })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1000, reason: 'idle timeout', hadError: false })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1000, reason: 'upstream error', hadError: false })).toBe(
      'reconnect',
    );
    expect(classifyPtyClose({ code: 1006, reason: '', hadError: false })).toBe('reconnect');
    expect(classifyPtyClose({ code: 1000, reason: '', hadError: true })).toBe('reconnect');
  });

  test('a lost id outranks an error flag and a non-1000 code', () => {
    expect(classifyPtyClose({ code: 1011, reason: 'pty not found', hadError: true })).toBe(
      'replace',
    );
  });
});

describe('sanitizePtyChunk', () => {
  test('drops the shell-integration payloads a VT emulator would print', () => {
    expect(sanitizePtyChunk('a\x1b]697;Foo=1\x07b')).toBe('ab');
    expect(sanitizePtyChunk('a\x1b]697;Foo=1\x1b\\b')).toBe('ab');
    expect(sanitizePtyChunk('x{"cursor":12}y')).toBe('xy');
    expect(sanitizePtyChunk('x\x00{"cursor":12}y')).toBe('xy');
  });

  test('drops the capability-query replies an idle prompt echoes back', () => {
    expect(sanitizePtyChunk('p\x1b[24;1Rq')).toBe('pq');
    expect(sanitizePtyChunk('p\x1b[?1;2cq')).toBe('pq');
    expect(sanitizePtyChunk('p\x1b[?2004$yq')).toBe('pq');
    expect(sanitizePtyChunk('p\x1b]11;rgb:0000/0000/0000\x07q')).toBe('pq');
    expect(sanitizePtyChunk('p\x1b]4;1;rgb:ffff/0000/0000\x1b\\q')).toBe('pq');
  });

  test('leaves real terminal output — prompts, colour, cursor motion — untouched', () => {
    // The sanitizer runs on every byte of the user's shell. Over-stripping is
    // worse than the noise it removes.
    expect(sanitizePtyChunk('kortix@sandbox:/workspace$ ')).toBe('kortix@sandbox:/workspace$ ');
    expect(sanitizePtyChunk('\x1b[32mgreen\x1b[0m')).toBe('\x1b[32mgreen\x1b[0m');
    expect(sanitizePtyChunk('\x1b[2J\x1b[H')).toBe('\x1b[2J\x1b[H');
    expect(sanitizePtyChunk('')).toBe('');
  });
});
