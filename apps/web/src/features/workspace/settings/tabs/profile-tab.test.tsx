import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactorRow, ProfileTabView, totpQrSrc } from './profile-tab';

/** Section titles in document order, read from the h2s the pane emits — the
 *  page heading (`SettingsTabHeader`) plus each section label. Row labels are
 *  NOT h2s any more: since the Linear restyle every setting is a row inside a
 *  `SettingsRowGroup`, and a row's label is a `FieldTitle`, not a heading. The
 *  row-order test below pins those separately. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders the pane heading and each section label, in order', () => {
    expect(headings(html())).toEqual(['Profile', 'Security', 'Danger zone']);
  });

  test('renders every setting row, in order', () => {
    const out = html();
    const rows = [
      'Profile picture',
      'Email',
      'Name',
      'Two-factor authentication',
      'Delete account',
    ];
    const positions = rows.map((label) => out.indexOf(`>${label}<`));
    expect(positions.some((p) => p < 0)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('consecutive rows share one bordered group', () => {
    // The whole point of the restyle: one border around the rows, hairlines
    // between them — not one bordered card per setting.
    expect(html()).toContain('data-slot="settings-row-group"');
  });

  test('the delete action is destructive', () => {
    expect(html()).toContain('destructive');
  });

  /**
   * Linear's rule, and Jay's: a destructive trigger is red TEXT. The filled
   * button is reserved for the confirmation inside `ConfirmDialog`/`Modal`,
   * which is where the commitment actually happens. `bg-destructive/80` is
   * the `destructive` Button variant's fill — its absence here is what says
   * the trigger did not silently go back to a solid red button.
   */
  test('delete account is a red text trigger, not a filled destructive button', () => {
    const out = html();
    expect(out).toContain('text-destructive');
    expect(out).not.toContain('bg-destructive/80');
  });

  /**
   * Was `expect(html()).toMatch(/<input[^>]*readonly/i)`. The email is not
   * editable, so it is no longer dressed as a field at all — a `readOnly`
   * input invites a click that does nothing. It renders as plain
   * right-aligned muted text, so the assertion flips: the value must be
   * present and there must be no read-only input left behind.
   */
  test('email renders as plain text, not a read-only field', () => {
    const out = renderToStaticMarkup(<ProfileTabView userEmail="ada@kortix.com" />);
    expect(out).toContain('ada@kortix.com');
    expect(out).not.toMatch(/<input[^>]*readonly/i);
  });

  test('renders no password-change control', () => {
    expect(html().toLowerCase()).not.toContain('password');
  });
});

/**
 * `factorsError` (fed by `useMfa()`'s `factorsQuery.isError`) must render a
 * real error state with a retry action instead of falling through to the
 * "No second factor enrolled" empty-state copy — that copy is a factual
 * claim that the factor list came back empty, not that it failed to load.
 */
describe('ProfileTabView — two-factor error state', () => {
  test('a failed factors fetch shows an error, not the empty-state banner', () => {
    const out = renderToStaticMarkup(<ProfileTabView factorsError />);
    expect(out).toContain('load your authenticator apps');
    expect(out).toContain('>Retry<');
    expect(out).not.toContain('No second factor enrolled');
  });

  test('loading takes priority over the error state', () => {
    const out = renderToStaticMarkup(<ProfileTabView factorsLoading factorsError />);
    expect(out).not.toContain('load your authenticator apps');
  });

  test('no error by default — the empty-state banner renders instead', () => {
    expect(html()).toContain('No second factor enrolled');
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
