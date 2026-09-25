import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  PROXY_ATTEMPT_TIMEOUT_MS,
  PROXY_RETRY_BUDGET_MS,
  isFileImportRequest,
  isLongTurnCompletionRequest,
  proxyAttemptTimeoutMs,
} from './preview-retry-budget';

// The daemon answers `POST /file/import` only after download, fsync and rename,
// bounded by its own IMPORT_TIMEOUT_MS. A shorter proxy attempt aborts a healthy
// import. That the import is never replayed is proven on the forward path
// (routes/forward.test.ts).
describe('/file/import', () => {
  const daemonFiles = readFileSync(
    new URL('../../../kortix-sandbox-agent-server/src/routes/files.ts', import.meta.url),
    'utf8',
  );
  const daemonImportTimeoutMs = Number(
    /const IMPORT_TIMEOUT_MS = ([\d_]+)/.exec(daemonFiles)?.[1]?.replaceAll('_', ''),
  );

  test('a daemon /file/import attempt outlasts the daemon\'s own import timeout', () => {
    expect(daemonImportTimeoutMs).toBeGreaterThan(PROXY_ATTEMPT_TIMEOUT_MS);
    const request = { method: 'POST', path: '/file/import', port: 8000 };
    expect(isFileImportRequest(request)).toBe(true);
    // The first attempt starts with the whole budget; the import still gets more
    // than the daemon's own bound, so the daemon always answers or aborts first.
    expect(proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, request)).toBeGreaterThan(
      daemonImportTimeoutMs,
    );
    expect(proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS - 20_000, request)).toBeGreaterThan(
      daemonImportTimeoutMs,
    );
    // Only the import POST: a GET or a lookalike path keeps the generic cap.
    expect(
      proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, { method: 'GET', path: '/file/import', port: 8000 }),
    ).toBe(PROXY_ATTEMPT_TIMEOUT_MS);
    expect(
      proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, { method: 'POST', path: '/file/imports', port: 8000 }),
    ).toBe(PROXY_ATTEMPT_TIMEOUT_MS);
  });

  // Only the daemon serves `/file/import`. The user's own server on another port
  // may expose the same path, and that request keeps the generic cap and budget.
  test('/file/import on a non-daemon port, or with no port, is an ordinary request', () => {
    for (const request of [
      { method: 'POST', path: '/file/import', port: 3000 },
      { method: 'POST', path: '/file/import', port: 4096 },
      { method: 'POST', path: '/file/import' },
    ]) {
      expect(isFileImportRequest(request)).toBe(false);
      expect(proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, request)).toBe(PROXY_ATTEMPT_TIMEOUT_MS);
      expect(proxyAttemptTimeoutMs(5_000, request)).toBe(5_000);
    }
  });
});

// `message`, `command` and `summarize` are OpenCode's blocking turn endpoints:
// the response is emitted only when the whole turn (or summary) is done. Capped
// at the generic 15s connect window, a healthy 20-40s turn is aborted and its
// non-idempotent body re-POSTed. `/command` was missing until 2026-08-11 (one
// `/webapp` submit became four identical user messages); `/summarize` until
// 2026-08-26 (every compaction died as `503 upstream unreachable`).
describe('isLongTurnCompletionRequest', () => {
  test.each([
    ['POST', '/session/abc123/message', true],
    ['post', '/session/abc-123/message', true],
    ['POST', '/session/abc123/message?x=1', true],
    ['POST', '/session/abc123/command', true],
    ['post', '/session/abc-123/command', true],
    ['POST', '/session/abc123/command?x=1', true],
    ['POST', '/session/abc123/summarize', true],
    ['post', '/session/abc-123/summarize', true],
    ['POST', '/session/abc123/summarize?x=1', true],
    // A transcript read, and the async sibling that returns immediately.
    ['GET', '/session/abc123/message', false],
    ['GET', '/session/abc123/command', false],
    ['GET', '/session/abc123/summarize', false],
    ['POST', '/session/abc123/prompt_async', false],
    // Lookalike paths.
    ['POST', '/not-session/abc123/message', false],
    ['POST', '/session/abc123/messages', false],
    ['POST', '/session/abc123/commands', false],
    ['POST', '/not-session/abc123/command', false],
    ['POST', '/session/abc123/summarizes', false],
    ['POST', '/not-session/abc123/summarize', false],
  ])('%s %s blocks for the whole turn: %p', (method, path, blocks) => {
    expect(isLongTurnCompletionRequest({ method, path })).toBe(blocks);
  });
});

describe('proxyAttemptTimeoutMs', () => {
  // The generic window, shrunk to whatever budget remains, with a 1s floor so
  // the last attempt still gets a chance.
  test.each([
    [50_000, 15_000],
    [40_000, 15_000],
    [15_000, 15_000],
    [10_000, 10_000],
    [2_500, 2_500],
    [800, 1_000],
    [0, 1_000],
    [-5_000, 1_000],
  ])('an ordinary request with %p ms of budget left gets %p ms', (remaining, attempt) => {
    expect(proxyAttemptTimeoutMs(remaining)).toBe(attempt);
    expect(proxyAttemptTimeoutMs(remaining, { method: 'GET', path: '/session/abc123/status' })).toBe(
      attempt,
    );
  });

  // A blocking turn and an upload get ~the whole remaining budget, not the 15s
  // cap, but never more than remains, and never less than the 1s floor.
  test.each([
    ['POST', '/session/abc123/message'],
    ['POST', '/session/abc123/command'],
    ['POST', '/session/abc123/summarize'],
    ['POST', '/file/upload'],
  ])('%s %s gets the remaining budget, bounded and floored', (method, path) => {
    expect(proxyAttemptTimeoutMs(40_000, { method, path })).toBe(39_500);
    expect(proxyAttemptTimeoutMs(PROXY_RETRY_BUDGET_MS, { method, path })).toBe(
      PROXY_RETRY_BUDGET_MS - 500,
    );
    expect(proxyAttemptTimeoutMs(5_000, { method, path })).toBe(4_500);
    expect(proxyAttemptTimeoutMs(200, { method, path })).toBe(1_000);
  });

  // The 60 s ALB idle cut is proven on the route, on a fake clock against a
  // hanging upstream: e2e-preview-proxy "when every upstream hangs".
});
