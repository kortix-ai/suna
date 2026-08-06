import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRetryableError, messageFor } from './use-create-workspace';
import { ApiError } from '@kortix/sdk';

const pageSource = readFileSync(join(import.meta.dir, 'new-workspace-page.tsx'), 'utf8');
const hookSource = readFileSync(join(import.meta.dir, 'use-create-workspace.ts'), 'utf8');

/**
 * Comments stripped, same convention as `new-workspace-page.test.ts` and
 * `advanced-fields.test.ts`. Both files' doc comments already discuss retry,
 * 502/503, and `messageFor` in prose — a raw `source.toContain(...)` /
 * `not.toContain(...)` check would risk matching (or missing) the comment
 * rather than the actual code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const page = stripComments(pageSource);
const hook = stripComments(hookSource);

describe('/new failure states: pre-existing coverage (regression pin)', () => {
  // Raw source (comments intact) on purpose for this block, matching the
  // brief's own draft: these are simple positive pins on documented facts —
  // e.g. `PROVISION_IN_FLIGHT_CODE`'s own doc comment names the literal
  // `409 provision_in_flight` code it wraps — not JSX-structure checks, so a
  // match landing in a comment is still real evidence the fact is documented
  // where a future reader would find it. Comments are stripped further down,
  // where new assertions need positional precision this task's own new doc
  // comments would otherwise satisfy by accident.
  test('a 403 names the missing permission rather than saying "failed"', () => {
    expect(hookSource).toContain('owner or admin access');
  });

  test('a 409 in-flight is retried with backoff, not surfaced as an error', () => {
    expect(hookSource).toContain('provision_in_flight');
    expect(hookSource).toContain('RETRY_DELAY_MS');
  });

  test('the page renders the error region', () => {
    expect(pageSource).toContain('role="alert"');
  });

  test('the form is re-enabled after a failure so the user can edit and resubmit', () => {
    expect(pageSource).toContain("status === 'creating'");
  });
});

describe('/new failure states: the retry affordance is wired to the UI', () => {
  test('the page destructures retry and canRetry from useCreateWorkspace', () => {
    expect(page).toContain('retry');
    expect(page).toContain('canRetry');
    // Paired presence check: pulled from the SAME hook call the rest of the
    // page's create state comes from, not a second, page-local invocation.
    const hookCalls = page.match(/useCreateWorkspace\(\)/g) ?? [];
    expect(hookCalls).toHaveLength(1);
  });

  test('the retry control sits inside the role="alert" region and calls retry(), not create() again', () => {
    const alertStart = page.indexOf('role="alert"');
    expect(alertStart).toBeGreaterThan(0);
    // The nearest enclosing element's opening tag.
    const containerStart = page.lastIndexOf('<div', alertStart);
    expect(containerStart).toBeGreaterThan(0);
    const region = page.slice(containerStart, page.indexOf('</form>', alertStart));

    expect(region).toContain('retry');
    // A retry must never re-run create() directly — that path exists to
    // mint/reuse a key from the CURRENT form state, not the failed attempt's
    // persisted one. `retry` (use-create-workspace.ts) already closes over
    // the last submitted state and reuses its key; calling create() again
    // from the page would bypass that and risk composing a different
    // payload from whatever the fields hold now.
    expect(region).not.toContain('onClick={() => void create(state)}');
    expect(region).not.toContain('onClick={create}');
  });

  test('the retry control is gated on canRetry so the 503 case (see below) can suppress it', () => {
    const alertStart = page.indexOf('role="alert"');
    const containerStart = page.lastIndexOf('<div', alertStart);
    const region = page.slice(containerStart, page.indexOf('</form>', alertStart));

    // Must be a real conditional on canRetry, not just the word floating
    // nearby in a comment or unrelated prop.
    const gated = /canRetry\s*(\?|&&)/.test(region);
    expect(gated).toBe(true);
  });

  test('the retry control reuses the Log out treatment — no third button weight', () => {
    // `Log out` (top-right) is the page's one existing secondary control:
    // variant="ghost" size="sm" className="text-muted-foreground
    // hover:text-foreground". The retry control must match that exact
    // color/weight treatment rather than inventing a third style (e.g. a
    // bare underlined link or a full-contrast button).
    const treatmentMatches = page.match(/text-muted-foreground hover:text-foreground/g) ?? [];
    expect(treatmentMatches).toHaveLength(2);
  });

  test('the retry control does not appear when status !== "error" — the whole region is gated on status', () => {
    const alertIndex = page.indexOf('role="alert"');
    const guardStart = page.lastIndexOf('{', alertIndex);
    const guard = page.slice(guardStart, alertIndex);
    expect(guard).toContain("status === 'error'");
  });
});

describe('/new failure states: 503 gets its own message and no retry', () => {
  test('the hook reuses isManagedGitUnavailableError instead of writing a second detector', () => {
    expect(hook).toContain('isManagedGitUnavailableError');
    expect(hook).toContain("from '@/lib/onboarding/ensure-first-project'");
    // Paired negative: the 503-detection string itself lives ONLY in
    // ensure-first-project.ts. If this file duplicated it, the two checks
    // could silently drift apart.
    expect(hook).not.toContain('is not configured on this server');
  });

  test('messageFor gives 502 the retryable generic message, unchanged', () => {
    expect(messageFor(new ApiError('Bad Gateway', { status: 502 }))).toBe(
      'Could not create the workspace. Try again.',
    );
  });

  test('messageFor gives 503 a distinct message that never tells the user to retry', () => {
    const msg = messageFor(
      new ApiError('Managed git is not configured on this server', { status: 503 }),
    );
    expect(msg).not.toBe('Could not create the workspace. Try again.');
    expect(msg).not.toContain('Try again');
    expect(msg).toContain("isn't set up on this server");
  });

  test('isRetryableError is false for the managed-git-unavailable 503, true for a 502', () => {
    expect(isRetryableError(new ApiError('Bad Gateway', { status: 502 }))).toBe(true);
    expect(
      isRetryableError(new ApiError('Managed git is not configured on this server', { status: 503 })),
    ).toBe(false);
  });

  test('isRetryableError is true for an ordinary network error — only managed-git-unavailable suppresses retry', () => {
    expect(isRetryableError(new Error('network error'))).toBe(true);
  });
});
