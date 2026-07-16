// The sign-in page must expose BOTH SSO doors: the silent home-realm
// discovery (typing a work email routes to the IdP automatically) and a
// visible "Use single sign-on (SSO)" action. The silent path alone is
// indistinguishable from "SSO doesn't exist" — users can't discover it,
// can't force it, and a failed lookup falls through with no explanation.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('sign-in SSO entry points', () => {
  test('silent home-realm discovery probes work-email domains', () => {
    expect(source).toContain('signInWithSSO');
    expect(source).toContain('isWorkEmail(trimmed)');
  });

  test('a visible SSO action exists and is gated on SAML being enabled', () => {
    expect(source).toContain('Use single sign-on (SSO)');
    expect(source).toContain('samlEnabled && (');
  });

  test('both doors share one probe (single redirect/callback construction)', () => {
    const helperDefs = source.match(/const attemptSsoRedirect = async/g) ?? [];
    expect(helperDefs.length).toBe(1);
    const calls = source.match(/attemptSsoRedirect\(trimmed\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('the explicit door surfaces a real error instead of silently falling through', () => {
    expect(source).toContain(`Single sign-on isn't set up for`);
  });

  test('the explicit door skips the consumer-domain gate (intent beats heuristics)', () => {
    const handler = source.slice(
      source.indexOf('const handleSsoContinue'),
      source.indexOf('const handleEntryContinue'),
    );
    expect(handler).not.toContain('isWorkEmail');
  });
});
