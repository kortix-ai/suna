import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationTabView } from './organization-tab';

/**
 * Pins the section order, the Enterprise group's negative gate, and the danger
 * zone's own gate. The whole-tab `account.write` gate lives in
 * `OrganizationTabInner` (the container), which calls
 * `useAuth`/`usePermission`/`useQuery` and therefore cannot render under
 * `renderToStaticMarkup` with no providers mounted — same reason
 * `audit-tab.test.tsx`/`api-keys-tab.test.tsx` never render their containers
 * directly, only their `*View`.
 *
 * Every assertion here reads a heading (`>Security<`) or a slot's own marker
 * text, never a class name or a wrapper's structure — `apps/web` has no DOM
 * harness, and a source-shaped assertion here would quietly become unable to
 * fail the moment the markup moved.
 */
describe('OrganizationTabView — section order', () => {
  test('General, Security, Enterprise features, then Danger zone — in that order', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView
        generalSlot={<div>real-general-content</div>}
        mfaSlot={<div>real-mfa-content</div>}
        sessionControlsSlot={<div>real-session-controls-content</div>}
        sessionsSlot={<div>real-sessions-content</div>}
        enterpriseVisible
        enterpriseSlot={<div>real-enterprise-content</div>}
        canDeleteAccount
      />,
    );
    const generalIdx = out.indexOf('>General<');
    const securityIdx = out.indexOf('>Security<');
    const enterpriseIdx = out.indexOf('>Enterprise features<');
    const dangerIdx = out.indexOf('>Danger zone<');

    expect(generalIdx).toBeGreaterThan(-1);
    expect(securityIdx).toBeGreaterThan(-1);
    expect(enterpriseIdx).toBeGreaterThan(-1);
    expect(dangerIdx).toBeGreaterThan(-1);
    expect(generalIdx).toBeLessThan(securityIdx);
    expect(securityIdx).toBeLessThan(enterpriseIdx);
    expect(enterpriseIdx).toBeLessThan(dangerIdx);
  });

  test('General renders its slot with no extra gate', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView generalSlot={<div>real-general-content</div>} />,
    );
    expect(out).toContain('real-general-content');
  });

  test('defaults (no props) render General and Security but neither Enterprise nor Danger zone', () => {
    const out = renderToStaticMarkup(<OrganizationTabView />);
    expect(out).toContain('>General<');
    expect(out).toContain('>Security<');
    expect(out).not.toContain('>Enterprise features<');
    expect(out).not.toContain('>Danger zone<');
  });
});

/**
 * MFA and the session policy are ONE group — they are one decision (how hard
 * it is to hold a session here), and the pane's whole point is that the panel
 * reads as one settings form rather than a stack of cards.
 *
 * The "Advanced" disclosure that used to hide the session-policy fields is
 * gone. As full cards those fields were genuinely too much for a pane most
 * people open to rename something; as two rows they cost two lines. These
 * tests pin that they are now rendered unconditionally, in the same section as
 * MFA — restoring a disclosure would fail the second one.
 */
describe('OrganizationTabView — Security section', () => {
  test('renders the MFA slot and the session-policy slot, both unconditionally', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView
        mfaSlot={<div>real-mfa-content</div>}
        sessionControlsSlot={<div>real-session-controls-content</div>}
      />,
    );
    expect(out).toContain('real-mfa-content');
    expect(out).toContain('real-session-controls-content');
  });

  test('the session policy is no longer hidden behind an Advanced disclosure', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView sessionControlsSlot={<div>real-session-controls-content</div>} />,
    );
    expect(out).not.toContain('Advanced');
    expect(out).not.toContain('Session lifetime and idle timeout.');
  });

  test('the sessions panel renders after the Security section, as its own block', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView
        mfaSlot={<div>real-mfa-content</div>}
        sessionsSlot={<div>real-sessions-content</div>}
      />,
    );
    expect(out.indexOf('real-mfa-content')).toBeLessThan(out.indexOf('real-sessions-content'));
  });
});

/**
 * `!entitlementsLoading && !accountState?.enterprise_license_available` — a
 * NEGATIVE gate. When a self-host operator's Enterprise licence already forces
 * every entitlement on, the group hides entirely (there is nothing left to
 * demo-toggle). `enterpriseVisible` carries that already-computed boolean —
 * these tests pin both states.
 */
describe('OrganizationTabView — Enterprise features negative gate', () => {
  test('visible renders the real enterprise-demo slot', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView enterpriseVisible enterpriseSlot={<div>real-enterprise-content</div>} />,
    );
    expect(out).toContain('>Enterprise features<');
    expect(out).toContain('real-enterprise-content');
  });

  test('not visible (license already forces every entitlement on) renders neither the heading nor the slot', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView
        enterpriseVisible={false}
        enterpriseSlot={<div>real-enterprise-content</div>}
      />,
    );
    expect(out).not.toContain('>Enterprise features<');
    expect(out).not.toContain('real-enterprise-content');
  });

  test('default (no props) is not visible', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView enterpriseSlot={<div>real-enterprise-content</div>} />,
    );
    expect(out).not.toContain('real-enterprise-content');
  });
});

/**
 * `canDeleteAccount` is `account.delete` — a DIFFERENT leaf from the whole-tab
 * `account.write` gate `OrganizationTabInner` enforces before this view ever
 * renders. Its own prop, never derived from `account.write`, so these tests
 * pin it in isolation from every other prop.
 */
describe('OrganizationTabView — Danger zone gate', () => {
  test('canDeleteAccount renders the Danger zone', () => {
    const out = renderToStaticMarkup(<OrganizationTabView canDeleteAccount />);
    expect(out).toContain('>Danger zone<');
    expect(out).toContain('Delete organization');
  });

  test('without canDeleteAccount the Danger zone is entirely absent', () => {
    const out = renderToStaticMarkup(<OrganizationTabView canDeleteAccount={false} />);
    expect(out).not.toContain('>Danger zone<');
    expect(out).not.toContain('Delete organization');
  });

  test('default (no props) has no Danger zone', () => {
    const out = renderToStaticMarkup(<OrganizationTabView />);
    expect(out).not.toContain('>Danger zone<');
  });

  /**
   * There is no `deleteAccount` in `@kortix/sdk`, so the row states that in
   * words and shows muted "Unavailable" text — it does NOT ship a disabled
   * destructive button that invites a click which can never do anything.
   * `profile-tab.tsx` shows the same "Unavailable" for the same reason.
   *
   * The `disabled=""` assertion is the load-bearing one: it is what fails if
   * anybody reintroduces a dead button here.
   */
  test('the delete row is muted text, not a disabled "Coming soon" button', () => {
    const out = renderToStaticMarkup(<OrganizationTabView canDeleteAccount />);
    expect(out).toContain('Unavailable');
    expect(out).not.toContain('Coming soon');
    expect(out).not.toContain('disabled=""');
  });
});

/**
 * Until an account id resolves there is nothing for any slot to fetch, and a
 * `SettingsRowGroup` with no rows in it is a visible empty bordered box. The
 * loading branch renders skeletons instead — and, critically, renders no
 * section headings, so the pane does not announce sections it cannot fill.
 */
describe('OrganizationTabView — loading', () => {
  test('isLoading renders neither the Security heading nor an empty Danger zone', () => {
    const out = renderToStaticMarkup(<OrganizationTabView isLoading canDeleteAccount />);
    expect(out).not.toContain('>Security<');
    expect(out).not.toContain('>Danger zone<');
  });

  test('isLoading still renders the pane heading', () => {
    const out = renderToStaticMarkup(<OrganizationTabView isLoading />);
    expect(out).toContain('>General<');
  });
});
