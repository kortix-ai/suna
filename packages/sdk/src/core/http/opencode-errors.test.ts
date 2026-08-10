import { test, expect } from 'bun:test';
import { formatOpenCodeRuntimeError } from './opencode-errors';

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
