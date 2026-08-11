import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A signup must never inherit the visitor's pre-signup return URL.
 *
 * `resolveNewAccountReturnUrl` holds the rule (see return-url.ts). This test is
 * the enforcement: the rule is only worth anything if EVERY path that turns an
 * authentication into a destination actually calls it. A path that quietly
 * stops calling it puts a brand-new account back on a stranger's "Request
 * access to this workspace" page, which is how this bug shipped in the first
 * place — the destination logic lives in four separate places and only the
 * invite case had ever been special-cased.
 *
 * Each entry names WHERE in that file the rule has to apply, so a rewrite that
 * moves the code still has to make a deliberate choice.
 */

const SRC = join(import.meta.dir, '..', '..');

const DESTINATION_PATHS = new Map<string, string>([
  [
    'app/(auth)/auth/actions.ts',
    'sendEmailCode (before the email link is minted), signUpWithPassword, signInWithPassword and verifyOtp all resolve a post-auth destination.',
  ],
  [
    'app/(auth)/auth/callback/route.ts',
    'OAuth/SSO/magic-link code exchange — the only signup path with no server action in front of it.',
  ],
]);

describe('the signup destination rule is wired into every auth path', () => {
  test('each destination-resolving file applies resolveNewAccountReturnUrl', () => {
    const missing: string[] = [];

    for (const [rel, why] of DESTINATION_PATHS) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      if (!source.includes('resolveNewAccountReturnUrl(')) missing.push(`${rel} — ${why}`);
    }

    expect(missing).toEqual([]);
  });

  test('the email-code flow applies the rule before minting the link, not after', () => {
    // A confirmation link can be opened days later, long after the "created in
    // the last 60s?" heuristic downstream stops being true. Resolving only on
    // the way out leaves the slow-email path broken — which is the exact shape
    // of the live report.
    const source = readFileSync(join(SRC, 'app/(auth)/auth/actions.ts'), 'utf8');
    const ruleAt = source.indexOf('resolveNewAccountReturnUrl(requestedReturnUrl)');
    const linkAt = source.indexOf('const emailRedirectTo = emailRedirectUrl(');

    expect(ruleAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeLessThan(linkAt);
  });
});
