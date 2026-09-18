/**
 * Enumerating a project is not using it.
 *
 * The account-wide MFA gate applies to `authorize()` — every per-project action
 * — and deliberately NOT to `listAccessibleProjects()`. That asymmetry is the
 * product decision, made after watching both alternatives on dev:
 *
 *   gate the list, swallow the reason  → the account renders EMPTY, with a
 *                                        "Create a project" link and no way to
 *                                        discover that 2FA was all that stood
 *                                        in the way. Granting more roles never
 *                                        helps: the gate sits ABOVE role
 *                                        evaluation in both functions.
 *   gate the list, surface the reason  → opening the project SWITCHER throws a
 *                                        modal auth challenge. Correct, and
 *                                        obnoxious.
 *   gate on open  (this)               → the switcher lists the projects; the
 *                                        challenge arrives when you open one.
 *
 * So: `authorize` must keep the gate, the listing must not have it, and no
 * listing denial may be returned without the reason that explains it. A future
 * reader "restoring symmetry" between the two functions breaks the UX on
 * purpose, which is why each half is pinned here.
 *
 * The remedy itself is untouched and already wired: the coded 403 →
 * the SDK's `kortix:mfa-required` event → `MfaStepUpProvider` in the web root
 * layout → TOTP → session upgraded to aal2 → `invalidateTokenCache()` +
 * `queryClient.invalidateQueries()`. Verified on dev: a member of an
 * MFA-required account completed the challenge and all five projects appeared.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mfaGateBlocks } from './authorize';

const source = readFileSync(resolve(import.meta.dir, 'authorize.ts'), 'utf8');

describe('mfaGateBlocks', () => {
  const required = { accountMfaRequired: true };
  const notRequired = { accountMfaRequired: false };

  test('a browser session below aal2 on an MFA-required account is blocked', () => {
    expect(mfaGateBlocks(required, null, 'aal1')).toBe(true);
    expect(mfaGateBlocks(required, null, undefined)).toBe(true);
  });

  test('a stepped-up browser session passes', () => {
    expect(mfaGateBlocks(required, null, 'aal2')).toBe(false);
  });

  test('a token is never blocked — it has no second factor to step up with', () => {
    expect(mfaGateBlocks(required, 'tok_1', 'aal1')).toBe(false);
    expect(mfaGateBlocks(required, 'tok_1', undefined)).toBe(false);
  });

  test('an account that does not require MFA never blocks', () => {
    expect(mfaGateBlocks(notRequired, null, 'aal1')).toBe(false);
    expect(mfaGateBlocks(notRequired, null, undefined)).toBe(false);
  });
});

describe('the MFA gate belongs to the action, not the enumeration', () => {
  const authorizeBody = (() => {
    const start = source.indexOf('export async function authorize(');
    return source.slice(start, source.indexOf('\nasync function ', start));
  })();
  const listBody = (() => {
    const start = source.indexOf('async function listAccessibleProjects');
    const end = source.indexOf('\nexport async function filterAccessibleObjects', start);
    return source.slice(start, end === -1 ? undefined : end);
  })();

  test('authorize() still gates every per-project action', () => {
    expect(authorizeBody).toContain('mfaGateBlocks(');
    expect(authorizeBody).toContain("deny('account_mfa_required')");
  });

  test('the listing does NOT gate — enumerating is not using', () => {
    expect(listBody).not.toContain('mfaGateBlocks(');
    // the reason may be NAMED in the comment that explains the omission; what
    // must not exist is a return that carries it.
    expect(listBody).not.toContain("reason: 'account_mfa_required'");
  });

  test('the condition is written once, in the predicate', () => {
    expect((source.match(/accountMfaRequired && !tokenId/g) ?? []).length).toBe(1);
  });

  test('no listing denial is returned without its reason', () => {
    // An empty list is not a refusal: a reason the caller could act on must
    // never be silently dropped, even though MFA is no longer one of them.
    expect(listBody).not.toMatch(/\{\s*mode:\s*'none'\s*\}/);
  });
});
