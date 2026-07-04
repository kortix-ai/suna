'use client';

import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrowserPanel } from '@/features/session/action-panel/browser-panel';
import { SessionActionsPanel } from '@/features/session/action-panel/session-actions-panel';
import { SessionAuditPanel } from '@/features/session/session-audit-panel';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SessionTerminalPanel } from '@/features/session/session-terminal-panel';
import { SessionWallpaperLayerContext } from '@/features/session/session-wallpaper-layer';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  SessionPanelView,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import type { SessionStartStage } from '@kortix/sdk/projects-client';
import { PanelRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type * as ResizablePrimitive from 'react-resizable-panels';

interface SessionLayoutProps {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  children: React.ReactNode;
  bootStage?: SessionStartStage | null;
  transient?: boolean;
}

export const SessionLayout = memo(function SessionLayout({
  sessionId,
  projectId,
  projectSessionId,
  children,
  bootStage = null,
  transient = false,
}: SessionLayoutProps) {
  const isMobile = useIsMobile();
  const booting = !!bootStage;

  const { data: messages } = useOpenCodeMessages(sessionId);

  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setActiveSession = useKortixComputerStore((s) => s.setActiveSession);
  const shouldOpenPanel = useKortixComputerStore((s) => s.shouldOpenPanel);
  const clearShouldOpenPanel = useKortixComputerStore((s) => s.clearShouldOpenPanel);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  const toggleExpanded = useKortixComputerStore((s) => s.toggleExpanded);

  const handleTogglePanel = useCallback(() => {
    setIsSidePanelOpen(!isSidePanelOpen);
  }, [isSidePanelOpen, setIsSidePanelOpen]);

  const isActiveTab = useTabStore((s) => s.activeTabId === sessionId);

  useEffect(() => {
    if (transient) return;
    if (isActiveTab) {
      setActiveSession(sessionId);
    }
  }, [transient, isActiveTab, sessionId, setActiveSession]);

  const storedPanelView = useSessionBrowserStore((s) => s.viewBySession[sessionId] ?? 'actions');
  const panelView: SessionPanelView = storedPanelView === 'files' ? 'explorer' : storedPanelView;
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const setActivePanelSession = useSessionBrowserStore((s) => s.setActiveSessionId);
  const showBrowser = panelView === 'browser';
  const showExplorer = panelView === 'explorer';
  const showTerminal = panelView === 'terminal';
  const showAudit = panelView === 'audit';

  // Pending-approval count for the "Audit" tab badge. Shares the header nudge's
  // query key so this is one deduped request; skipped while booting/transient.
  const { data: auditData } = useSessionAudit(projectId, projectSessionId, {
    enabled: !transient && !booting && !!projectId && !!projectSessionId,
    silent: true,
  });
  const auditPendingCount = (auditData?.actions ?? []).filter(isPendingAction).length;

  useEffect(() => {
    if (shouldOpenPanel && !isSidePanelOpen) {
      setIsSidePanelOpen(true);
      clearShouldOpenPanel();
    } else if (shouldOpenPanel) {
      clearShouldOpenPanel();
    }
  }, [shouldOpenPanel, isSidePanelOpen, setIsSidePanelOpen, clearShouldOpenPanel]);

  const handleSidePanelClose = useCallback(() => {
    if (isExpanded) toggleExpanded();
    setIsSidePanelOpen(false);
  }, [setIsSidePanelOpen, isExpanded, toggleExpanded]);

  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef(isExpanded);

  const [wallpaperLayer, setWallpaperLayer] = useState<HTMLDivElement | null>(null);

  const shouldShowPanel = isSidePanelOpen;

  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);
  const shouldHandleHotkey = isInTabSystem ? isActiveTab : true;

  const isVisibleLayout = isInTabSystem ? isActiveTab : true;
  useEffect(() => {
    if (transient) return;
    if (!isVisibleLayout) return;
    setActivePanelSession(sessionId);
    return () => {
      if (useSessionBrowserStore.getState().activeSessionId === sessionId) {
        setActivePanelSession(null);
      }
    };
  }, [transient, isVisibleLayout, sessionId, setActivePanelSession]);
  useEffect(() => {
    if (!shouldHandleHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        if (isSidePanelOpen) handleSidePanelClose();
        else setIsSidePanelOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shouldHandleHotkey, isSidePanelOpen, handleSidePanelClose, setIsSidePanelOpen]);

  const [isAnimating, setIsAnimating] = useState(false);

  const enablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'flex 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    });
  }, []);

  const disablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'none';
    });
  }, []);

  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    prevExpandedRef.current = isExpanded;

    const shouldAnimate = expandChanged && shouldShowPanel;

    if (shouldAnimate) {
      setIsAnimating(true);
    }

    if (shouldShowPanel) {
      if (isExpanded) {
        sidePanelRef.current?.resize(100);
        mainPanelRef.current?.resize(0);
      } else {
        sidePanelRef.current?.resize(50);
        mainPanelRef.current?.resize(50);
      }
    } else {
      sidePanelRef.current?.resize(0);
      mainPanelRef.current?.resize(100);
    }

    if (shouldAnimate) {
      const timer = setTimeout(() => {
        disablePanelTransition();
        setIsAnimating(false);
      }, 320);
      return () => clearTimeout(timer);
    }
  }, [shouldShowPanel, isExpanded, sessionId, disablePanelTransition]);

  useEffect(() => {
    if (!isAnimating) return;
    const raf = requestAnimationFrame(() => {
      enablePanelTransition();
      if (isExpanded) {
        sidePanelRef.current?.resize(100);
        mainPanelRef.current?.resize(0);
      } else {
        sidePanelRef.current?.resize(50);
        mainPanelRef.current?.resize(50);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isAnimating, enablePanelTransition, isExpanded]);

  const panelHeader = (
    <PanelHeaderSwitcher
      view={panelView}
      onChangeView={(v) => setPanelView(sessionId, v)}
      isSidePanelOpen={isSidePanelOpen}
      onTogglePanel={handleTogglePanel}
      auditBadge={auditPendingCount}
    />
  );

  const [terminalActivated, setTerminalActivated] = useState(false);
  useEffect(() => {
    if (showTerminal) setTerminalActivated(true);
  }, [showTerminal]);

  const [browserActivated, setBrowserActivated] = useState(false);
  useEffect(() => {
    if (showBrowser) setBrowserActivated(true);
  }, [showBrowser]);

  const swappableBody = showAudit ? (
    <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
  ) : showExplorer ? (
    <SessionFilesExplorer
      chatSessionId={sessionId}
      projectId={projectId}
      projectSessionId={projectSessionId}
    />
  ) : (
    <SessionActionsPanel sessionId={sessionId} messages={messages} />
  );
  const panelBody = (
    <div className="relative h-full w-full">
      {terminalActivated && (
        <div className={cn('absolute inset-0', !showTerminal && 'hidden')}>
          <SessionTerminalPanel sessionId={sessionId} hidden={!showTerminal} />
        </div>
      )}
      {browserActivated && (
        <div className={cn('absolute inset-0', !showBrowser && 'hidden')}>
          <BrowserPanel
            tabId={sessionPreviewTabId(sessionId)}
            projectId={projectId}
            projectSessionId={projectSessionId}
          />
        </div>
      )}
      <div className={cn('absolute inset-0', (showTerminal || showBrowser) && 'hidden')}>
        {swappableBody}
      </div>
    </div>
  );

  const effectivePanelHeader = booting ? null : panelHeader;
  const effectivePanelBody = booting ? (
    <SessionStartingLoader
      stage={bootStage ?? 'provisioning'}
      delayMs={0}
      projectId={projectId}
      sessionId={projectSessionId}
    />
  ) : (
    panelBody
  );

  if (isMobile) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        <Drawer
          open={shouldShowPanel}
          onOpenChange={(open) => {
            if (!open) handleSidePanelClose();
          }}
        >
          <DrawerContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden p-0">
            {effectivePanelHeader}
            <div className="min-h-0 flex-1 overflow-hidden">{effectivePanelBody}</div>
          </DrawerContent>
        </Drawer>
      </div>
    );
  }

  return (
    <SessionWallpaperLayerContext.Provider value={wallpaperLayer}>
      <div
        className="bg-background relative flex h-full flex-col overflow-hidden"
        data-testid="session-layout"
      >
        <div ref={panelGroupRef} className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full bg-transparent"
            style={{ transition: 'none' }}
          >
            <ResizablePanel
              ref={mainPanelRef}
              defaultSize={shouldShowPanel ? 50 : 100}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 0 : 30) : 100}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 0 : 65) : 100}
              collapsible={isExpanded || isAnimating}
              className={cn(
                'relative flex flex-col overflow-hidden bg-transparent transition-[padding] duration-300 ease-out',
                isExpanded && !isAnimating && 'pointer-events-none opacity-0',
              )}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
            </ResizablePanel>

            <ResizableHandle
              withHandle={shouldShowPanel && !isExpanded}
              disabled={!shouldShowPanel || isExpanded}
              className={cn(
                'z-20 transition-opacity duration-300',
                shouldShowPanel && !isExpanded
                  ? 'w-0 opacity-100'
                  : 'pointer-events-none w-0 opacity-0',
              )}
            />

            <ResizablePanel
              ref={sidePanelRef}
              defaultSize={shouldShowPanel ? 50 : 0}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
              collapsible={!isExpanded || isAnimating}
              className={cn('bg-background relative overflow-hidden', !shouldShowPanel && 'hidden')}
            >
              <div
                className={cn('bg-background h-full transition-[padding] duration-300 ease-out')}
              >
                <div className="border-border flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l">
                  {effectivePanelHeader}
                  <div className="min-h-0 flex-1 overflow-hidden">{effectivePanelBody}</div>
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </SessionWallpaperLayerContext.Provider>
  );
});

function PanelHeaderSwitcher({
  view,
  onChangeView,
  isSidePanelOpen,
  onTogglePanel,
  auditBadge = 0,
}: {
  view: SessionPanelView;
  onChangeView: (next: SessionPanelView) => void;
  isSidePanelOpen: boolean;
  onTogglePanel: () => void;
  /** Pending-approval count shown on the "Audit" tab; 0 hides the badge. */
  auditBadge?: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex shrink-0 items-center justify-between border-b p-2">
      <Tabs
        value={view}
        onValueChange={(next) => onChangeView(next as SessionPanelView)}
        className="gap-0 p-0"
      >
        <TabsList
          type="secondary"
          animate="none"
          size="sm"
          className="h-7 border-b-0 p-0"
          aria-label={tHardcodedUi.raw(
            'componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView',
          )}
        >
          <TabsTrigger size="xs" value="actions" variant="secondary" className="h-7 w-fit">
            Actions
          </TabsTrigger>
          <TabsTrigger size="xs" value="browser" variant="secondary" className="h-7 w-fit">
            Browser
          </TabsTrigger>
          <TabsTrigger size="xs" value="explorer" variant="secondary" className="h-7 w-fit">
            Files
          </TabsTrigger>
          <TabsTrigger size="xs" value="terminal" variant="secondary" className="h-7 w-fit">
            Terminal
          </TabsTrigger>
          <TabsTrigger size="xs" value="audit" variant="secondary" className="h-7 w-fit">
            Audit
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Hint
        side="bottom"
        sideOffset={4}
        delayDuration={300}
        label={
          <span className="flex items-center gap-1.5">
            {isSidePanelOpen ? 'Close' : 'Open'} panel
            <KbdGroup>
              <Kbd className="font-mono">
                {tHardcodedUi.raw('componentsSessionSessionSiteHeader.line185JsxTextI')}
              </Kbd>
            </KbdGroup>
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onTogglePanel}
          className={cn(
            'h-7 cursor-pointer transition-colors',
            isSidePanelOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </Hint>
    </div>
  );
}
