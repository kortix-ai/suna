import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { IdentityTabView } from './identity-tab';

/**
 * Pins the entitlement gate `IdentityTabView` implements — see this tab's
 * header comment for the exact `file:line` this mirrors
 * (`app/(app)/accounts/[id]/page.tsx:300,310,603-619`). Unlike Roles
 * (`rbacEnabled = !!entitlements?.rbac`), Identity gates on `!!(entitlements
 * ?.sso || entitlements?.scim)` — an OR of two leaves, neither of which is
 * `rbac`. The whole-tab `account.write` gate lives in `IdentityTabInner` (the
 * container), which calls `useAuth`/`usePermission`/`useQuery` and therefore
 * can't render under `renderToStaticMarkup` with no providers mounted — same
 * reason `roles-tab.test.tsx` never renders `RolesTab` directly, only
 * `RolesTabView`.
 */
describe('IdentityTabView', () => {
  test('entitled (sso OR scim) renders the real intro/SSO/SCIM slots, not the upsell or a skeleton', () => {
    const out = renderToStaticMarkup(
      <IdentityTabView
        identityEnabled
        introSlot={<div>real-intro-content</div>}
        ssoSlot={<div>real-sso-content</div>}
        scimSlot={<div>real-scim-content</div>}
      />,
    );
    expect(out).toContain('real-intro-content');
    expect(out).toContain('real-sso-content');
    expect(out).toContain('real-scim-content');
    expect(out).not.toContain('Enterprise feature');
  });

  test('non-entitled renders EnterpriseUpsell in place of the pane — this view still renders content, not nothing', () => {
    const out = renderToStaticMarkup(
      <IdentityTabView
        identityEnabled={false}
        introSlot={<div>real-intro-content</div>}
        ssoSlot={<div>real-sso-content</div>}
        scimSlot={<div>real-scim-content</div>}
      />,
    );
    expect(out).toContain('SAML SSO &amp; SCIM are Enterprise features');
    expect(out).not.toContain('real-intro-content');
    expect(out).not.toContain('real-sso-content');
    expect(out).not.toContain('real-scim-content');
  });

  test('loading renders neither the slots nor the upsell — a skeleton only', () => {
    const out = renderToStaticMarkup(
      <IdentityTabView
        isLoading
        identityEnabled
        introSlot={<div>real-intro-content</div>}
        ssoSlot={<div>real-sso-content</div>}
        scimSlot={<div>real-scim-content</div>}
      />,
    );
    expect(out).not.toContain('real-intro-content');
    expect(out).not.toContain('real-sso-content');
    expect(out).not.toContain('real-scim-content');
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('loading wins even when identityEnabled is false — never flashes the upsell while still resolving', () => {
    const out = renderToStaticMarkup(<IdentityTabView isLoading identityEnabled={false} />);
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('defaults (no props) render the non-entitled upsell, not a crash', () => {
    const out = renderToStaticMarkup(<IdentityTabView />);
    expect(out).toContain('SAML SSO &amp; SCIM are Enterprise features');
  });
});
