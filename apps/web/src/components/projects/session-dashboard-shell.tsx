'use client';

import { lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { AppProviders } from '@/components/layout/app-providers';
import { TabBar } from '@/components/tabs/tab-bar';
import { OpenCodeEventStreamProvider } from '@/hooks/opencode/use-opencode-events';
import { UpdateDialogProvider } from '@/components/update-dialog-provider';
import { useWebNotifications } from '@/hooks/use-web-notifications';
import { useTabStore } from '@/stores/tab-store';
import { cn } from '@/lib/utils';

// Lazy-load heavy descendants — mirrors layout-content.tsx exactly so the
// chunk graph matches the canonical instance dashboard.
const StatusOverlay = lazy(() =>
  import('@/components/ui/status-overlay').then((mod) => ({
    default: mod.StatusOverlay,
  })),
);
const PresentationViewerWrapper = lazy(() =>
  import('@/stores/presentation-viewer-store').then((mod) => ({
    default: mod.PresentationViewerWrapper,
  })),
);
const GlobalProviderModal = lazy(() =>
  import('@/components/providers/provider-modal').then((mod) => ({
    default: mod.GlobalProviderModal,
  })),
);
const SessionLayout = lazy(() =>
  import('@/components/session/session-layout').then((mod) => ({
    default: mod.SessionLayout,
  })),
);
const SessionChat = lazy(() =>
  import('@/components/session/session-chat').then((mod) => ({
    default: mod.SessionChat,
  })),
);
const FileTabContent = lazy(() =>
  import('@/components/tabs/file-tab-content').then((mod) => ({
    default: mod.FileTabContent,
  })),
);
const PreviewTabContent = lazy(() =>
  import('@/components/tabs/preview-tab-content').then((mod) => ({
    default: mod.PreviewTabContent,
  })),
);
const TerminalTabContent = lazy(() =>
  import('@/components/tabs/terminal-tab-content').then((mod) => ({
    default: mod.TerminalTabContent,
  })),
);
const PageTabContent = lazy(() =>
  import('@/components/tabs/page-tab-content').then((mod) => ({
    default: mod.PageTabContent,
  })),
);
const RunningServicesPanel = lazy(() =>
  import('@/components/tabs/running-services-panel').then((mod) => ({
    default: mod.RunningServicesPanel,
  })),
);
const BrowserTabContent = lazy(() =>
  import('@/components/tabs/browser-tab-content').then((mod) => ({
    default: mod.BrowserTabContent,
  })),
);
const DesktopTabContent = lazy(() =>
  import('@/components/tabs/desktop-tab-content').then((mod) => ({
    default: mod.DesktopTabContent,
  })),
);

/** Renders nothing — only mounts the web-notifications hook. */
function WebNotificationProvider() {
  useWebNotifications();
  return null;
}

/**
 * Pre-mounted tab content container. Verbatim copy of the canonical
 * `SessionTabsContainer` in `layout-content.tsx` minus the onboarding-mode
 * branches (this shell is never used in onboarding). Keeps all open tabs
 * alive in the DOM so switching tabs is instant.
 */
function SessionTabsContainer({ children }: { children: React.ReactNode }) {
  const tabs = useTabStore((s) => s.tabs) || {};
  const tabOrder = useTabStore((s) => s.tabOrder) || [];
  const activeTabId = useTabStore((s) => s.activeTabId);

  const sessionTabIds = tabOrder.filter((id) => tabs[id]?.type === 'session');
  const fileTabIds = tabOrder.filter((id) => tabs[id]?.type === 'file');
  const previewTabIds = tabOrder.filter((id) => tabs[id]?.type === 'preview');
  const terminalTabIds = tabOrder.filter((id) => tabs[id]?.type === 'terminal');
  const servicesTabIds = tabOrder.filter((id) => tabs[id]?.type === 'services');
  const browserTabIds = tabOrder.filter((id) => tabs[id]?.type === 'browser');
  const desktopTabIds = tabOrder.filter((id) => tabs[id]?.type === 'desktop');
  const pageTabIds = tabOrder.filter((id) => {
    const t = tabs[id]?.type;
    return t === 'settings' || t === 'page' || t === 'project' || t === 'dashboard';
  });
  const activeTab = activeTabId ? tabs[activeTabId] : null;
  const showingMountedTab = !!activeTab;

  return (
    <div
      className={cn(
        'bg-background flex-1 min-h-0 flex flex-col overflow-hidden relative',
      )}
    >
      {sessionTabIds.map((id) => (
        <div
          key={id}
          className={cn(
            'absolute inset-0 flex flex-col',
            id !== activeTabId && 'hidden',
          )}
        >
          <Suspense fallback={null}>
            <SessionLayout sessionId={id}>
              <SessionChat sessionId={id} />
            </SessionLayout>
          </Suspense>
        </div>
      ))}

      {fileTabIds.map((id) => {
        const tab = tabs[id];
        if (!tab) return null;
        const filePath = id.startsWith('file:') ? id.slice(5) : id;
        return (
          <div
            key={id}
            className={cn(
              'absolute inset-0 flex flex-col',
              id !== activeTabId && 'hidden',
            )}
          >
            <Suspense fallback={null}>
              <FileTabContent tabId={id} filePath={filePath} />
            </Suspense>
          </div>
        );
      })}

      {previewTabIds.map((id) => (
        <div
          key={id}
          className={cn(
            'absolute inset-0 flex flex-col',
            id !== activeTabId && 'hidden',
          )}
        >
          <Suspense fallback={null}>
            <PreviewTabContent tabId={id} />
          </Suspense>
        </div>
      ))}

      {terminalTabIds.map((id) => {
        const ptyId = id.startsWith('terminal:') ? id.slice(9) : id;
        return (
          <div
            key={id}
            className={cn(
              'absolute inset-0 flex flex-col',
              id !== activeTabId && 'hidden',
            )}
          >
            <Suspense fallback={null}>
              <TerminalTabContent
                ptyId={ptyId}
                tabId={id}
                hidden={id !== activeTabId}
              />
            </Suspense>
          </div>
        );
      })}

      {servicesTabIds.map((id) => (
        <div
          key={id}
          className={cn(
            'absolute inset-0 flex flex-col',
            id !== activeTabId && 'hidden',
          )}
        >
          <Suspense fallback={null}>
            <RunningServicesPanel />
          </Suspense>
        </div>
      ))}

      {browserTabIds.map((id) => (
        <div
          key={id}
          className={cn(
            'absolute inset-0 flex flex-col',
            id !== activeTabId && 'hidden',
          )}
        >
          <Suspense fallback={null}>
            <BrowserTabContent />
          </Suspense>
        </div>
      ))}

      {desktopTabIds.map((id) => (
        <div
          key={id}
          className={cn(
            'absolute inset-0 flex flex-col',
            id !== activeTabId && 'hidden',
          )}
        >
          <Suspense fallback={null}>
            <DesktopTabContent />
          </Suspense>
        </div>
      ))}

      {pageTabIds.map((id) => {
        const tab = tabs[id];
        if (!tab) return null;
        return (
          <div
            key={id}
            className={cn(
              'absolute inset-0 flex flex-col overflow-y-auto',
              id !== activeTabId && 'hidden',
            )}
          >
            <Suspense fallback={null}>
              <PageTabContent href={tab.href} />
            </Suspense>
          </div>
        );
      })}

      <div
        className={cn(
          'flex-1 min-h-0 flex flex-col overflow-y-auto',
          showingMountedTab && 'hidden',
        )}
      >
        {children}
      </div>
    </div>
  );
}

interface SessionDashboardShellProps {
  /** Sandbox/instance ID this shell is bound to — currently used only as a
   *  React key so a navigation between two session sandboxes remounts the
   *  inner tree (and resets pre-mounted tab content). */
  sandboxId: string;
  initialSidebarOpen?: boolean;
  children: React.ReactNode;
}

/**
 * `SessionDashboardShell` — the same chrome as the canonical
 * `(dashboard)/layout.tsx` (instance dashboard), but stripped of:
 *  - the onboarding state machine (BootOverlay / SetupWizard / morph chrome)
 *  - the primary-sandbox auto-creation hook (`useSandbox()`)
 *  - the global health / connection store early returns (the page-level
 *    lifecycle gate handles transient sandbox states for THIS session)
 *  - route-syncing / instance-cookie reconciliation (the page explicitly
 *    `switchToInstanceAsync`'s the active server before mounting us)
 *  - the AAL background checker (not session-specific)
 *
 * Visually identical to `layout-content.tsx` lines 1015–1112: same
 * `AppProviders` (with default `<SidebarLeft />`), same animated `<TabBar />`,
 * same rounded-corner inner panel, same `<SessionTabsContainer>` host.
 */
export function SessionDashboardShell({
  sandboxId,
  initialSidebarOpen,
  children,
}: SessionDashboardShellProps) {
  return (
    <AppProviders
      key={sandboxId}
      showSidebar
      defaultSidebarOpen={initialSidebarOpen}
      sidebarSiblings={
        <Suspense fallback={null}>
          <StatusOverlay />
        </Suspense>
      }
    >
      <OpenCodeEventStreamProvider />
      <WebNotificationProvider />
      <UpdateDialogProvider />
      <Suspense fallback={null}>
        <GlobalProviderModal />
      </Suspense>

      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        <AnimatePresence initial={false}>
          <motion.div
            key="tab-bar"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <TabBar />
          </motion.div>
        </AnimatePresence>

        <div className="flex-1 min-h-0 flex flex-col md:border md:border-b-0 md:border-border/50 overflow-hidden md:rounded-t-xl relative">
          <SessionTabsContainer>{children}</SessionTabsContainer>
        </div>

        <Suspense fallback={null}>
          <PresentationViewerWrapper />
        </Suspense>
      </div>
    </AppProviders>
  );
}
