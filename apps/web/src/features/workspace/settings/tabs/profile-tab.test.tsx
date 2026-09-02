import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileTabView } from './profile-tab';

/** Section titles in document order, read from the h2s the pane emits — the
 *  page heading (`SettingsTabHeader`) plus each section label. Row labels are
 *  NOT h2s any more: since the Linear restyle every setting is a row inside a
 *  `SettingsRowGroup`, and a row's label is a `FieldTitle`, not a heading. The
 *  row-order test below pins those separately. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders the pane heading and each section label, in order', () => {
    expect(headings(html())).toEqual(['Profile', 'Danger zone']);
  });

  test('renders every setting row, in order', () => {
    const out = html();
    const rows = ['Profile picture', 'Email', 'Name', 'Delete account'];
    const positions = rows.map((label) => out.indexOf(`>${label}<`));
    expect(positions.some((p) => p < 0)).toBe(false);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * Jay, 2026-08-17: "in the user settings also have all the accounts you're a
   * part of so you can easily go to the account settings as well from the user
   * settings."
   *
   * Placement is the requirement, not just presence — "easily" means the list
   * is reachable without scrolling past Security and Danger zone, and without
   * finding a tab first. So it sits directly under the identity group and
   * ABOVE Security. `account-memberships.test.tsx` covers the section itself;
   * this pins where it lands on the pane.
   */
  describe('organizations', () => {
    const withAccounts = () =>
      renderToStaticMarkup(
        <ProfileTabView
          accounts={[{ account_id: 'acc_1', name: 'Acme', account_role: 'owner' }]}
        />,
      );

    test('lists each account with a link to its settings', () => {
      const out = withAccounts();
      expect(out).toContain('href="/accounts/acc_1"');
      expect(out).toContain('>Acme<');
    });

    test('sits under the identity rows and above Danger zone', () => {
      expect(headings(withAccounts())).toEqual(['Profile', 'Organizations', 'Danger zone']);
      expect(withAccounts().indexOf('>Email<')).toBeLessThan(
        withAccounts().indexOf('Organizations'),
      );
    });

    /** No account list, no section — the pane is unchanged for a reader whose
     *  accounts query has not answered. This is why the heading assertion at
     *  the top of this file still reads three headings. */
    test('adds nothing to the pane when the list is unknown', () => {
      expect(headings(html())).toEqual(['Profile', 'Danger zone']);
    });
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
 * Two-factor authentication is not on this pane any more — it is the Security
 * tab (`security-tab.tsx`, pinned by `security-tab.test.tsx`). Asserted absent
 * so the section cannot quietly grow back here as a second copy.
 */
describe('ProfileTabView — no security section', () => {
  test('renders no two-factor row and no factor banner', () => {
    const out = html();
    expect(out).not.toContain('Two-factor authentication');
    expect(out).not.toContain('No second factor enrolled');
  });
});
