// The member-side half of account-wide MFA: pure-view pieces render the
// factor states an admin's "Require MFA" flip depends on, and the QR
// normalizer must feed <img> both Supabase shapes (data URL vs raw SVG).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { FactorRow, totpQrSrc } from './security-tab';

describe('totpQrSrc', () => {
  test('passes a data URL through untouched', () => {
    const url = 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E';
    expect(totpQrSrc(url)).toBe(url);
  });

  test('wraps raw SVG into an encoded data URL', () => {
    const out = totpQrSrc('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(out.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(out).toContain('%3Csvg');
  });
});

describe('FactorRow', () => {
  test('verified authenticator renders name, type, and verified badge', () => {
    const html = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f1', friendly_name: 'My phone', factor_type: 'totp', status: 'verified' }}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('My phone');
    expect(html).toContain('verified');
    expect(html).toContain('Remove factor');
  });

  test('unnamed totp factor falls back to "Authenticator app"', () => {
    const html = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f2', factor_type: 'totp', status: 'unverified' }}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('Authenticator app');
    expect(html).toContain('unverified');
  });
});
