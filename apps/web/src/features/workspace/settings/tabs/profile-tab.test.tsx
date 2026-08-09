import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactorRow, ProfileTabView, totpQrSrc } from './profile-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders every section heading in order', () => {
    expect(headings(html())).toEqual([
      'Profile picture',
      'Name',
      'Email',
      'Two-factor authentication',
      'Delete account',
    ]);
  });

  test('the delete action is destructive', () => {
    expect(html()).toContain('destructive');
  });

  test('email is read-only', () => {
    expect(html()).toMatch(/<input[^>]*readonly/i);
  });

  test('renders no password-change control', () => {
    expect(html().toLowerCase()).not.toContain('password');
  });
});

// Ported from the deleted `features/accounts/settings/security-tab.test.tsx`
// (Task 10) — `FactorRow` and `totpQrSrc` moved into `profile-tab.tsx`, this
// tab being their only remaining consumer once the legacy user-settings
// modal and `security-tab.tsx` were retired.
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
    const factorHtml = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f1', friendly_name: 'My phone', factor_type: 'totp', status: 'verified' }}
        onRemove={() => {}}
      />,
    );
    expect(factorHtml).toContain('My phone');
    expect(factorHtml).toContain('verified');
    expect(factorHtml).toContain('Remove factor');
  });

  test('unnamed totp factor falls back to "Authenticator app"', () => {
    const factorHtml = renderToStaticMarkup(
      <FactorRow
        factor={{ id: 'f2', factor_type: 'totp', status: 'unverified' }}
        onRemove={() => {}}
      />,
    );
    expect(factorHtml).toContain('Authenticator app');
    expect(factorHtml).toContain('unverified');
  });
});
