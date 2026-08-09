import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GroupsTabView } from './groups-tab';

/**
 * Pins the entitlement gate `GroupsTabView` implements — see this tab's
 * header comment for the exact `file:line` this mirrors
 * (`app/(app)/accounts/[id]/page.tsx:308,310,536-544`). Groups has NO
 * permission gate (`page.tsx:356 groups: true`) — every member reaches this
 * pane, so there is no fourth "container renders null" state to pin here the
 * way `roles-tab.test.tsx` does for `role.create`.
 */
describe('GroupsTabView', () => {
  test('entitled (rbacEnabled) renders the real groups slot, not the upsell or a skeleton', () => {
    const out = renderToStaticMarkup(
      <GroupsTabView rbacEnabled groupsSlot={<div>real-groups-content</div>} />,
    );
    expect(out).toContain('real-groups-content');
    expect(out).not.toContain('Enterprise feature');
  });

  test('non-entitled renders EnterpriseUpsell in place of the pane — this view still renders content, not nothing', () => {
    const out = renderToStaticMarkup(
      <GroupsTabView rbacEnabled={false} groupsSlot={<div>real-groups-content</div>} />,
    );
    expect(out).toContain('Groups are an Enterprise feature');
    expect(out).not.toContain('real-groups-content');
  });

  test('loading renders neither the pane nor the upsell — a skeleton only', () => {
    const out = renderToStaticMarkup(
      <GroupsTabView isLoading rbacEnabled groupsSlot={<div>real-groups-content</div>} />,
    );
    expect(out).not.toContain('real-groups-content');
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('loading wins even when rbacEnabled is false — never flashes the upsell while still resolving', () => {
    const out = renderToStaticMarkup(<GroupsTabView isLoading rbacEnabled={false} />);
    expect(out).not.toContain('Enterprise feature');
    expect(out).toContain('animate-pulse');
  });

  test('defaults (no props) render the non-entitled upsell, not a crash', () => {
    const out = renderToStaticMarkup(<GroupsTabView />);
    expect(out).toContain('Groups are an Enterprise feature');
  });
});
