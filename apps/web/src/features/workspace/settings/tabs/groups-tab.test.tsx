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

/**
 * Fix round 1 — the terminal "no account ever resolves" state, distinct
 * from the transient loading window. See this file's header comment
 * ("Fix round 1 — the terminal no-account state") for the full trace
 * proving `resolvedAccountId` staying `undefined` forever is reachable only
 * via an `['accounts']` fetch failure, never via a genuinely empty account
 * list (the API always bootstraps one — `apps/api/src/accounts/core/
 * accounts.ts:76-100`).
 */
describe('GroupsTabView — terminal no-account state', () => {
  test('accountResolutionFailed renders an honest terminal state, not an indefinite skeleton', () => {
    const out = renderToStaticMarkup(<GroupsTabView accountResolutionFailed isLoading />);
    expect(out).not.toContain('animate-pulse');
    expect(out).toContain("determine your account");
  });

  test('accountResolutionFailed takes precedence over isLoading and rbacEnabled', () => {
    const out = renderToStaticMarkup(
      <GroupsTabView
        accountResolutionFailed
        isLoading
        rbacEnabled
        groupsSlot={<div>real-groups-content</div>}
      />,
    );
    expect(out).not.toContain('real-groups-content');
    expect(out).not.toContain('animate-pulse');
    expect(out).toContain("determine your account");
  });

  test('the terminal state renders a Retry action when a retry handler is supplied', () => {
    const out = renderToStaticMarkup(
      <GroupsTabView accountResolutionFailed onRetryAccountResolution={() => {}} />,
    );
    expect(out).toContain('Retry');
  });

  test('the terminal state renders no action when no retry handler is supplied', () => {
    const out = renderToStaticMarkup(<GroupsTabView accountResolutionFailed />);
    expect(out).not.toContain('Retry');
  });

  test('accountResolutionFailed defaults to false — ordinary loading is unaffected', () => {
    const out = renderToStaticMarkup(<GroupsTabView isLoading />);
    expect(out).toContain('animate-pulse');
    expect(out).not.toContain("determine your account");
  });
});
