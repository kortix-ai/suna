import { afterEach, describe, expect, test } from 'bun:test';

import { LAST_PROJECT_COOKIE, serializeLastProject } from '@/lib/onboarding/landing-destination';
import { forgetLastProjectId, readLastProjectId } from './last-project-cookie';

/**
 * JAY-729: an unrenderable project must be able to FORGET itself as the
 * remembered landing target — but only itself. Deleting a project, or hitting
 * its terminal 403/404 gate, clears the cookie only when the cookie names that
 * exact project; a cookie pointing somewhere healthy survives.
 */

type MutableGlobals = { document?: unknown };
const g = globalThis as MutableGlobals;
const originalDocument = g.document;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';

function stubCookie(value: string | null): { cookie: string } {
  const stub = {
    cookie: value
      ? `${LAST_PROJECT_COOKIE}=${encodeURIComponent(value)}`
      : '',
  };
  g.document = stub;
  return stub;
}

afterEach(() => {
  g.document = originalDocument;
});

describe('forgetLastProjectId', () => {
  test('clears the cookie when it names exactly the unrenderable project', () => {
    const stub = stubCookie(serializeLastProject(USER, PROJECT));
    expect(readLastProjectId(USER)).toBe(PROJECT);

    forgetLastProjectId(USER, PROJECT);

    // The clear writes an expired cookie; the raw store must no longer parse
    // back to the project.
    expect(stub.cookie).toContain('Max-Age=0');
  });

  test('leaves a cookie that remembers a DIFFERENT project untouched', () => {
    const stub = stubCookie(serializeLastProject(USER, OTHER_PROJECT));

    forgetLastProjectId(USER, PROJECT);

    expect(stub.cookie).not.toContain('Max-Age=0');
    expect(readLastProjectId(USER)).toBe(OTHER_PROJECT);
  });

  test('a cookie owned by ANOTHER user is never cleared on this user’s verdict', () => {
    const stub = stubCookie(serializeLastProject(OTHER_USER, PROJECT));

    forgetLastProjectId(USER, PROJECT);

    expect(stub.cookie).not.toContain('Max-Age=0');
  });

  test('no document (server render) is a no-op, not a crash', () => {
    g.document = undefined;
    expect(() => forgetLastProjectId(USER, PROJECT)).not.toThrow();
  });
});
