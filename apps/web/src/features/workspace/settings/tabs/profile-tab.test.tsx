import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The app's Bun tests have no DOM and Radix's portal renders nothing under
// `renderToStaticMarkup`; the dialog-content tests below need that markup, so
// the portal-based `Modal` is replaced by a flat stand-in — the same handling
// as `sub-session-modal.characterization.test.tsx`. The real modal behavior
// is exercised by the browser journeys.
mock.module('@/components/ui/modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  ModalBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Imported after the mock so the module binds to the stand-in.
const { ProfileTabView } = await import('./profile-tab');

/** Section titles in document order, read from the h2s the pane emits — the
 *  page heading (`SettingsTabHeader`) plus each section label. Row labels are
 *  NOT h2s any more: since the Linear restyle every setting is a row inside a
 *  `SettingsRowGroup`, and a row's label is a `FieldTitle`, not a heading. The
 *  row-order test below pins those separately. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

const html = () => renderToStaticMarkup(<ProfileTabView />);

describe('ProfileTabView', () => {
  test('renders injected locale copy instead of fixed English labels', () => {
    const out = renderToStaticMarkup(
      <ProfileTabView
        copy={{
          profilePicture: 'Профилна слика',
          email: 'Имејл',
          name: 'Име',
          dangerZone: 'Опасна зона',
          deleteAccount: 'Обриши налог',
        }}
      />,
    );

    for (const label of ['Профилна слика', 'Имејл', 'Име', 'Опасна зона', 'Обриши налог']) {
      expect(out).toContain(label);
    }
    expect(out).not.toContain('>Profile picture<');
    expect(out).not.toContain('>Danger zone<');
  });

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
      // `?accountId=acc_1` — the hub is a modal on the current page, not a
      // route. Rendered with no router context, the href is the query-only
      // relative form.
      expect(out).toContain('href="?accountId=acc_1"');
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

  /** KRTX-1403: with the 30-day option selected the banner read "Your account
   *  is scheduled for deletion…" — present tense, an already-done state —
   *  while GET /v1/account/deletion-status concurrently reported
   *  `has_pending_deletion:false`. The line must describe what CHOOSING the
   *  option does, so it carries "will be scheduled" and never the
   *  present-tense form again. */
  test('the grace-period banner states the consequence, not an already-scheduled deletion', () => {
    const out = renderToStaticMarkup(<ProfileTabView showDeleteDialog />);
    expect(out).toContain('will be scheduled for deletion after a 30-day grace period');
    expect(out).not.toContain('is scheduled for deletion after a 30-day grace period');
  });

  /** The immediate option's banner was already conditional; pin it so the two
   *  options stay in the same voice. */
  test('the immediate banner states the consequence of the option', () => {
    const out = renderToStaticMarkup(
      <ProfileTabView showDeleteDialog deletionType="immediate" />,
    );
    expect(out).toContain('deletes your account right away');
  });

  /** KRTX-1403: the confirm input rendered the literal word "delete" as its
   *  placeholder on every open, so the dialog never looked empty and the word
   *  read as a carried-over confirmation. The label above the input already
   *  names the word; the field itself must render bare. */
  test('the confirm input renders without a placeholder word', () => {
    const out = renderToStaticMarkup(<ProfileTabView showDeleteDialog />);
    const input = out.match(/<input[^>]*id="profile-delete-confirm"[^>]*>/);
    expect(input).toBeTruthy();
    expect(input?.[0]).not.toContain('placeholder=');
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
