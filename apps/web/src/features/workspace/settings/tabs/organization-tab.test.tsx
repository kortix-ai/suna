import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationTabView } from './organization-tab';

/**
 * Pins the group order, the closed-by-default Advanced disclosure, the
 * Enterprise group's negative gate, and the danger zone's own gate —
 * exactly the shape `app/(app)/accounts/[id]/page.tsx:621-685` implements
 * for `activeSection === 'settings'`. The whole-tab `account.write` gate
 * lives in `OrganizationTabInner` (the container), which calls
 * `useAuth`/`usePermission`/`useQuery` and therefore can't render under
 * `renderToStaticMarkup` with no providers mounted — same reason
 * `audit-tab.test.tsx`/`api-keys-tab.test.tsx` never render their
 * containers directly, only their `*View`.
 */
describe('OrganizationTabView — group order', () => {
  test('General, Security, Enterprise features, then Danger zone — in that order', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView
        generalSlot={<div>real-general-content</div>}
        mfaSlot={<div>real-mfa-content</div>}
        sessionControlsSlot={<div>real-session-controls-content</div>}
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

  test('Security renders the MFA slot with no extra gate', () => {
    const out = renderToStaticMarkup(<OrganizationTabView mfaSlot={<div>real-mfa-content</div>} />);
    expect(out).toContain('real-mfa-content');
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
 * `page.tsx:631-635`'s comment: MFA is the one control most accounts touch;
 * session lifetime and idle timeout are compliance-shop noise, so they hide
 * under an "Advanced" disclosure closed by default. `Disclosure` defaults
 * `open` to `false` when no `open` prop is passed
 * (`components/ui/disclosure.tsx:90`), and `DisclosureContent`'s children
 * only render while `open` is true (`disclosure.tsx:206`), so under
 * `renderToStaticMarkup` the trigger label appears but the session-controls
 * slot's content does not — this must NOT be promoted open.
 */
describe('OrganizationTabView — Advanced disclosure stays closed by default', () => {
  test('the Advanced trigger renders, but the session controls slot content does not', () => {
    const out = renderToStaticMarkup(
      <OrganizationTabView sessionControlsSlot={<div>real-session-controls-content</div>} />,
    );
    expect(out).toContain('Advanced');
    expect(out).toContain('Session lifetime and idle timeout.');
    expect(out).not.toContain('real-session-controls-content');
  });
});

/**
 * `page.tsx:669`: `!entitlementsLoading &&
 * !accountStateQuery.data?.enterprise_license_available` — a NEGATIVE gate.
 * When a self-host operator's Enterprise licence already forces every
 * entitlement on, the group hides entirely (there's nothing left to
 * demo-toggle). `enterpriseVisible` on `OrganizationTabView` carries that
 * already-computed boolean — these tests pin both states.
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
 * `page.tsx:324,681`: `canDeleteAccount` is `account.delete` — a DIFFERENT
 * leaf from the whole-tab `account.write` gate `OrganizationTabInner`
 * enforces before this view ever renders. This is its own, separate prop —
 * never derived from `account.write` — so these tests pin it in isolation
 * from every other prop.
 */
describe('OrganizationTabView — Danger zone gate', () => {
  test('canDeleteAccount renders the Danger zone with a disabled "Coming soon" delete button', () => {
    const out = renderToStaticMarkup(<OrganizationTabView canDeleteAccount />);
    expect(out).toContain('>Danger zone<');
    expect(out).toContain('Delete account');
    expect(out).toContain('Coming soon');
    expect(out).toContain('disabled=""');
  });

  test('without canDeleteAccount the Danger zone is entirely absent', () => {
    const out = renderToStaticMarkup(<OrganizationTabView canDeleteAccount={false} />);
    expect(out).not.toContain('>Danger zone<');
    expect(out).not.toContain('Delete account');
  });

  test('default (no props) has no Danger zone', () => {
    const out = renderToStaticMarkup(<OrganizationTabView />);
    expect(out).not.toContain('>Danger zone<');
  });
});
