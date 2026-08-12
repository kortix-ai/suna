import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RolesTabView } from './roles-tab';

/**
 * Pins the entitlement gate `RolesTabView` implements — see this tab's
 * header comment for the exact `file:line` this mirrors
 * (`app/(app)/accounts/[id]/page.tsx:308,310,547-559`). Unlike Groups, Roles
 * ALSO carries a `role.create` whole-tab gate (`page.tsx:357`), but that
 * lives in `RolesTabInner` (the container), which calls `useAuth`/
 * `usePermission`/`useQuery` and therefore can't render under
 * `renderToStaticMarkup` with no providers mounted — see this tab's header
 * comment for why that gate is asserted by code-reading + the container's
 * own "placed after every hook" shape instead of a render test here, the
 * same way `billing-tab.test.tsx` never renders `BillingTab` (the
 * container) directly, only `BillingTabView`.
 */
describe('RolesTabView', () => {
  test('entitled (rbacEnabled) renders the real roles slot, not the upsell or a skeleton', () => {
    const out = renderToStaticMarkup(
      <RolesTabView rbacEnabled rolesSlot={<div>real-roles-content</div>} />,
    );
    expect(out).toContain('real-roles-content');
    expect(out).not.toContain('Enterprise feature');
  });

  test('non-entitled renders EnterpriseUpsell in place of the pane — this view still renders content, not nothing', () => {
    const out = renderToStaticMarkup(
      <RolesTabView rbacEnabled={false} rolesSlot={<div>real-roles-content</div>} />,
    );
    expect(out).toContain('Custom roles are an Enterprise feature');
    expect(out).not.toContain('real-roles-content');
  });

  test('loading renders neither the pane nor the upsell — a skeleton only', () => {
    const out = renderToStaticMarkup(
      <RolesTabView isLoading rbacEnabled rolesSlot={<div>real-roles-content</div>} />,
    );
    expect(out).not.toContain('real-roles-content');
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('loading wins even when rbacEnabled is false — never flashes the upsell while still resolving', () => {
    const out = renderToStaticMarkup(<RolesTabView isLoading rbacEnabled={false} />);
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('defaults (no props) render the non-entitled upsell, not a crash', () => {
    const out = renderToStaticMarkup(<RolesTabView />);
    expect(out).toContain('Custom roles are an Enterprise feature');
  });
});
