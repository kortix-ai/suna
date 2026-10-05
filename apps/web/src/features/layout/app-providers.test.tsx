/**
 * Characterization for `AppProviders`' rendered tree, upgraded from a
 * source-text read before the unreachable legacy right rail was deleted
 * (KRTX-1012): the providers must still wrap the page, the injected sidebar
 * slot must render, and no legacy rail may come back.
 */
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

const Named = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

// Collaborator stubs. Each named component records that it rendered, so the
// assertions below see the real AppProviders tree through them.
const stub = (name: string, extra: Record<string, unknown> = {}) =>
  mock.module(name, () => ({ default: Named, ...extra }));

stub('@/components/ui/sidebar', {
  SidebarProvider: ({ children }: { children?: ReactNode }) => (
    <div data-stub="SidebarProvider">{children}</div>
  ),
  SidebarInset: ({ children }: { children?: ReactNode }) => (
    <div data-stub="SidebarInset">{children}</div>
  ),
  SidebarLeft: Named,
});
stub('@/features/billing/global-upgrade-modal', { GlobalUpgradeModal: Named });
stub('@/features/connectors/connector-connection-gate-dialog', {
  ConnectorConnectionGateDialog: Named,
});
stub('@/lib/storage/managed-storage', { pruneAllRegisteredCaches: () => {} });
stub('@/components/ui/sidebar-width', { SIDEBAR_MAX_WIDTH_PX: 416 });
mock.module('@/lib/config', () => ({ isBillingEnabled: () => false }));
mock.module('@/stores/onboarding-mode-store', () => ({
  useOnboardingModeStore: () => ({ active: false, morphing: false }),
}));
mock.module('@/stores/subscription-store', () => ({
  SubscriptionStoreSync: ({ children }: { children?: ReactNode }) => (
    <div data-stub="SubscriptionStoreSync">{children}</div>
  ),
}));

const { AppProviders } = await import('./app-providers');

test('keeps subscription sync around the children and the global dialogs, inside the sidebar providers', () => {
  const html = renderToStaticMarkup(
    <AppProviders sidebarContent={<span id="left-slot">left</span>}>
      <span id="page-children">children</span>
    </AppProviders>,
  );
  expect(html).toContain('page-children');
  expect(html).toContain('left-slot');
  expect(html).toContain('data-stub="SidebarProvider"');
  expect(html).toContain('data-stub="SidebarInset"');
  expect(html).toContain('data-stub="SubscriptionStoreSync"');
});

test('billing off renders no upgrade modal, and no legacy right rail returns', () => {
  const html = renderToStaticMarkup(
    <AppProviders>
      <span id="page-children">children</span>
    </AppProviders>,
  );
  expect(html).not.toContain('GlobalUpgradeModal');
  expect(html).not.toContain('Quick actions');
  expect(html).not.toContain('sidebar-right');
});

test('showSidebar=false returns the bare content, without the sidebar providers', () => {
  const html = renderToStaticMarkup(
    <AppProviders showSidebar={false}>
      <span id="bare">bare</span>
    </AppProviders>,
  );
  expect(html).toContain('bare');
  expect(html).not.toContain('data-stub="SidebarProvider"');
  expect(html).not.toContain('data-stub="SidebarInset"');
});
