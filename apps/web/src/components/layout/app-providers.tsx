'use client';

import React from 'react';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RightSidebarProvider } from '@/components/ui/sidebar-right-provider';
import { useOnboardingModeStore } from '@/stores/onboarding-mode-store';
import { useDeleteOperationEffects } from '@/stores/delete-operation-store';
import { SubscriptionStoreSync } from '@/stores/subscription-store';
import { useModelHydration } from '@/hooks/opencode/use-model-hydration';
import { NewInstanceModal } from '@/components/billing/pricing/new-instance-modal';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { AccountSettingsModal } from '@/components/settings/account-settings-modal';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { GlobalUpgradeDialog } from '@/components/billing/upgrade-dialog';
import { isBillingEnabled } from '@/lib/config';
import { SidebarLeft } from '@/components/sidebar/sidebar-left';
import { SidebarRight } from '@/components/sidebar/sidebar-right';

/**
 * Left sidebar slot — lives inside SidebarProvider so it can read the
 * onboarding morph state.
 *
 * Width is NOT driven by the `open` state here — `SidebarLeft` uses
 * `collapsible="icon"`, so the collapsed state still shows a 3.25rem icon
 * rail. Letting the inner `<Sidebar>` manage its own width means the main
 * content's rounded left edge sits flush with the rail (not the viewport)
 * in both states.
 *
 * `SidebarLeft` is imported eagerly (not lazy/Suspense) so there's no
 * skeleton→real swap on initial load — that swap was the "weird flicker"
 * on load, since the skeleton pulse and the real sidebar's own entrance
 * both fired in the first few frames.
 *
 * The only time we clamp this slot ourselves is during the onboarding
 * hide-sidebar morph: we animate max-width to 0 so the sidebar slides out
 * entirely. A `booted` flag suppresses that transition on first paint so
 * the initial render never flashes an animation.
 */
function SidebarLeftSlot({ sidebarContent }: { sidebarContent?: React.ReactNode }) {
  const obActive = useOnboardingModeStore((s) => s.active);
  const obMorphing = useOnboardingModeStore((s) => s.morphing);
  const hideSidebar = obActive && !obMorphing;

  // Suppress transitions on the very first paint so nothing animates on
  // initial load. Flip on the next frame so the onboarding morph still
  // animates when it fires later.
  const [booted, setBooted] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setBooted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      data-slot="sidebar-left-slot"
      className={
        booted
          ? 'transition-[max-width,opacity] duration-500 ease-out overflow-hidden'
          : 'overflow-hidden'
      }
      style={{
        // Normal mode: use a max-width larger than any real sidebar width
        // so it never constrains the inner <Sidebar> (which manages its
        // own 280px / 3.25rem widths via `collapsible="icon"`).
        // Onboarding-hide: clamp to 0 so the sidebar slides out with an
        // animation — CSS needs a concrete start value to transition from.
        maxWidth: hideSidebar ? 0 : 320,
        opacity: hideSidebar ? 0 : 1,
      }}
    >
      {sidebarContent || <SidebarLeft />}
    </div>
  );
}

function DeleteOperationEffectsWrapper({ children }: { children: React.ReactNode }) {
  useDeleteOperationEffects();
  return <>{children}</>;
}

/** Store-driven NewInstanceModal — mounted by legacy dashboard surfaces only. */
function GlobalNewInstanceModal() {
  const { isOpen, title, closeNewInstanceModal } = useNewInstanceModalStore();
  return <NewInstanceModal open={isOpen} onOpenChange={(o) => !o && closeNewInstanceModal()} title={title} />;
}

/** Store-driven UserSettingsModal — mounted once globally so the error handler
 *  can route billing errors to the Billing tab with a highlight. */
function GlobalUserSettingsModal() {
  const { isOpen, defaultTab, closeUserSettings } = useUserSettingsModalStore();
  return (
    <UserSettingsModal
      open={isOpen}
      onOpenChange={(o) => !o && closeUserSettings()}
      defaultTab={defaultTab}
    />
  );
}

/** Store-driven AccountSettingsModal — billing + transactions live here.
 *  Mounted alongside the user settings modal so any caller (WorkspaceMenu,
 *  402 error handler, session error banner) can open it from anywhere. */
function GlobalAccountSettingsModal() {
  const { isOpen, defaultTab, closeAccountSettings } = useAccountSettingsModalStore();
  if (!isBillingEnabled()) return null;
  return (
    <AccountSettingsModal
      open={isOpen}
      onOpenChange={(o) => !o && closeAccountSettings()}
      defaultTab={defaultTab}
    />
  );
}

interface AppProvidersProps {
  children: React.ReactNode;
  showSidebar?: boolean;
  /**
   * Right rail control. `true` (default) mounts the legacy `<SidebarRight />`
   * with all the dashboard nav (Files, Terminal, Secrets, Triggers, etc.).
   * Project routes pass `false` so the session view is just the conversation
   * inside the project's own chrome — no extra dashboard noise.
   */
  showRightSidebar?: boolean;
  defaultSidebarOpen?: boolean;
  sidebarContent?: React.ReactNode;
  sidebarSiblings?: React.ReactNode;
  showGlobalNewInstanceModal?: boolean;
  showGlobalUserSettingsModal?: boolean;
}

export function AppProviders({
  children,
  showSidebar = true,
  showRightSidebar = true,
  defaultSidebarOpen,
  sidebarContent,
  sidebarSiblings,
  showGlobalNewInstanceModal = false,
  showGlobalUserSettingsModal = false,
}: AppProvidersProps) {
  useModelHydration(showRightSidebar);

  const content = (
    <DeleteOperationEffectsWrapper>
      <SubscriptionStoreSync>
        {children}
        {showGlobalNewInstanceModal && <GlobalNewInstanceModal />}
        {showGlobalUserSettingsModal && (
          <>
            <GlobalUserSettingsModal />
            <GlobalAccountSettingsModal />
          </>
        )}
        {isBillingEnabled() && <GlobalUpgradeDialog />}
      </SubscriptionStoreSync>
    </DeleteOperationEffectsWrapper>
  );

  if (!showSidebar) return content;

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <SidebarLeftSlot sidebarContent={sidebarContent} />
      <SidebarInset>
        <RightSidebarProvider>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {content}
          </div>
          {showRightSidebar && <SidebarRight />}
        </RightSidebarProvider>
      </SidebarInset>
      {sidebarSiblings}
    </SidebarProvider>
  );
}
