import { test, expect } from 'bun:test';
import { formatOpenCodeRuntimeError, isSandboxNotReadyError } from './opencode-errors';

// Both inputs below are constructed as real `Error` instances — that is the
// ONLY shape `formatOpenCodeRuntimeError` is ever actually called with.
// `unwrap()` (react/use-opencode-sessions/shared.ts) is what turns the
// proxy's parsed JSON body into the error this function receives, and it
// always `throw new Error(String(msg))`. A plain object literal (`{ message:
// '...' }`, not `instanceof Error`) is NOT that shape: `rawErrorMessage`
// treats non-Error objects as "serialize the whole thing", which double-JSON-
// encodes an already-stringified `.message` field and breaks payload parsing
// for BOTH branches below — confirmed by running this exact shape against the
// pre-existing (untouched) ConfigInvalidError branch, which also fails on it.

test('a stopped-sandbox 503 is dormancy, not an OpenCode failure', () => {
  // The real shape: `unwrap()` picks `body.error` off the parsed 503 JSON
  // (`{ error: 'sandbox not ready (status: stopped)', port, status }`) and
  // re-throws `new Error(body.error)` — the JSON wrapper does NOT survive,
  // only the bare phrase does.
  const formatted = formatOpenCodeRuntimeError(new Error('sandbox not ready (status: stopped)'));
  expect(formatted.title).toBe('Session is waking up');
  expect(formatted.title).not.toBe('OpenCode failed to load');
});

// ── isSandboxNotReadyError ──────────────────────────────────────────────────
// One phrase per production site in apps/api. Each is a readiness state the
// control plane reports on purpose — never a crash — so a UI must show
// "waking up" and keep polling, not a terminal error card.

test('classifies every proxy readiness phrase as sandbox-not-ready', () => {
  const readiness = [
    // sandbox-proxy/routes/preview.ts — `sandbox not ready (status: ${record.status})`
    'sandbox not ready (status: stopped)',
    'sandbox not ready (status: starting)',
    'sandbox not ready (status: archived)',
    // preview.ts WebSocket resolver — bare phrase, no status suffix
    'sandbox not ready',
    // sandbox-proxy/routes/public-share.ts
    'Sandbox is not running',
    // public-session-shares + shared/session-public-shares
    'Sandbox is not ready',
    // daemon 503 passed through while OpenCode itself is still booting
    'opencode not ready',
    // projects/lib/session-transcript.ts + shared/public-session-share-view.ts
    'OpenCode session not ready in the sandbox',
    'OpenCode not ready in the sandbox',
    'OpenCode is not ready in the sandbox yet',
    // stable machine codes on 503 bodies (preview.ts)
    'sandbox_not_ready',
    'sandbox_lifecycle_unavailable',
  ];
  for (const phrase of readiness) {
    expect({ phrase, notReady: isSandboxNotReadyError(new Error(phrase)) }).toEqual({
      phrase,
      notReady: true,
    });
  }
});

test('accepts the raw string and JSON-wrapped bodies, not just Error instances', () => {
  // Public share view throws `new Error(text)` where text is the whole 503
  // JSON body — the phrase survives inside it.
  expect(isSandboxNotReadyError('sandbox not ready (status: stopped)')).toBe(true);
  expect(
    isSandboxNotReadyError(
      new Error('{"error":"Sandbox is not ready","status":503}'),
    ),
  ).toBe(true);
});

test('does not classify genuine failures as sandbox-not-ready', () => {
  const genuine = [
    'file not found',
    'Path is a directory',
    // Box is active but the port never answered — a real failure, not parking.
    'sandbox port unreachable',
    'OpenCode failed to load',
    'Internal Server Error',
    '',
    // Mentions "stopped" without being the readiness phrase.
    'process stopped unexpectedly',
  ];
  for (const phrase of genuine) {
    expect({ phrase, notReady: isSandboxNotReadyError(new Error(phrase)) }).toEqual({
      phrase,
      notReady: false,
    });
  }
  expect(isSandboxNotReadyError(null)).toBe(false);
  expect(isSandboxNotReadyError(undefined)).toBe(false);
});

test('formatOpenCodeRuntimeError treats every readiness phrase as waking, not just status: stopped', () => {
  for (const phrase of [
    'sandbox not ready (status: starting)',
    'sandbox not ready',
    'Sandbox is not ready',
  ]) {
    const formatted = formatOpenCodeRuntimeError(new Error(phrase));
    expect({ phrase, title: formatted.title }).toEqual({
      phrase,
      title: 'Session is waking up',
    });
  }
});

test('a genuine config error keeps its own title', () => {
  // The real shape: `unwrap()` finds no `.message`/`.error` field on the
  // ConfigInvalidError body, so it falls through to `JSON.stringify(err)` and
  // throws `new Error('{"name":"ConfigInvalidError",...}')` — the JSON
  // survives whole this time, inside a real Error's `.message`.
  const formatted = formatOpenCodeRuntimeError(
    new Error(JSON.stringify({ name: 'ConfigInvalidError', data: { path: '/workspace/opencode.json' } })),
  );
  expect(formatted.title).toBe('OpenCode config is invalid');
});
