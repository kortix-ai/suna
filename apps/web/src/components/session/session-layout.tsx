'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { KortixComputer } from '@/components/thread/kortix-computer';
import { PreviewTabContent } from '@/components/tabs/preview-tab-content';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useKortixComputerStore,
} from '@/stores/kortix-computer-store';
import {
  useOpenCodeMessages,
  useOpenCodeSession,
} from '@/hooks/opencode/use-opencode-sessions';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useTabStore } from '@/stores/tab-store';
import {
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import {
  adaptMessagesToToolCalls,
  adaptAgentStatus,
} from '@/lib/adapters/opencode-to-kortix-computer';
import { X } from 'lucide-react';

// ============================================================================
// Session Layout
// ============================================================================

interface SessionLayoutProps {
  sessionId: string;
  children: React.ReactNode;
}

export const SessionLayout = memo(function SessionLayout({
  sessionId,
  children,
}: SessionLayoutProps) {
  const isMobile = useIsMobile();

  const { data: messages } = useOpenCodeMessages(sessionId);
  const { data: session } = useOpenCodeSession(sessionId);

  const sessionStatus = useSyncStore(
    (s) => s.sessionStatus[sessionId],
  );
  const isBusy = sessionStatus?.type === 'busy';

  const toolCalls = useMemo(
    () => (messages ? adaptMessagesToToolCalls(messages) : []),
    [messages],
  );
  const agentStatus = adaptAgentStatus(isBusy);

  // Use individual selectors to avoid re-rendering on unrelated store changes
  // (e.g. currentSandboxId, files store resets). Destructuring the whole store
  // subscribes to ALL properties and causes unnecessary re-renders for every
  // open session tab.
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setActiveSession = useKortixComputerStore((s) => s.setActiveSession);
  const shouldOpenPanel = useKortixComputerStore((s) => s.shouldOpenPanel);
  const clearShouldOpenPanel = useKortixComputerStore((s) => s.clearShouldOpenPanel);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  const toggleExpanded = useKortixComputerStore((s) => s.toggleExpanded);

  // Track active tab to restore per-session panel state on tab switch
  const activeTabId = useTabStore((s) => s.activeTabId);
  const isActiveTab = activeTabId === sessionId;

  useEffect(() => {
    if (isActiveTab) {
      setActiveSession(sessionId);
    }
  }, [isActiveTab, sessionId, setActiveSession]);

  const hasToolCalls = toolCalls.length > 0;

  // Right-side panel view — actions (tool calls) or internal browser.
  // Per-session, so each session remembers which view the user prefers.
  const panelView = useSessionBrowserStore((s) => s.viewBySession[sessionId] ?? 'actions');
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const showBrowser = panelView === 'browser';

  useEffect(() => {
    if (shouldOpenPanel && !isSidePanelOpen) {
      setIsSidePanelOpen(true);
      clearShouldOpenPanel();
    } else if (shouldOpenPanel) {
      clearShouldOpenPanel();
    }
  }, [shouldOpenPanel, isSidePanelOpen, setIsSidePanelOpen, clearShouldOpenPanel]);

  const [currentToolIndex, setCurrentToolIndex] = useState(0);
  const [externalNavIndex, setExternalNavIndex] = useState<number | undefined>(undefined);

  const handleSidePanelNavigate = useCallback((index: number) => {
    setCurrentToolIndex(index);
  }, []);

  const handleSidePanelClose = useCallback(() => {
    if (isExpanded) toggleExpanded();
    setIsSidePanelOpen(false);
  }, [setIsSidePanelOpen, isExpanded, toggleExpanded]);

  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef(isExpanded);

  // Side panel is visible when the user has explicitly opened it AND there's
  // something to show. The "something to show" rule used to be just "we have
  // tool calls"; with the browser view it also includes "browser is the
  // active view" — so the user can pop the panel open just to use the
  // internal browser even before the agent has run any tools.
  const shouldShowPanel = isSidePanelOpen && (hasToolCalls || showBrowser);

  // Track whether we're mid-animation so we can use relaxed constraints
  // that allow intermediate sizes (e.g. 75%) during the transition.
  const [isAnimating, setIsAnimating] = useState(false);

  // Enable smooth CSS transition on panel flex properties during expand/collapse.
  // react-resizable-panels uses flex-basis internally; adding a transition on
  // the flex shorthand makes the imperative resize() calls animate smoothly.
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

  // Imperatively resize panels when visibility, expand state, or session changes.
  // Including sessionId ensures panels are correctly sized after navigating
  // between sessions (e.g. fork → parent), since the ResizablePanelGroup may
  // retain stale sizes from the previous session's layout.
  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    prevExpandedRef.current = isExpanded;

    // Only animate when the expand state toggles (not on initial mount or
    // session switch). Panel open/close has its own flow.
    const shouldAnimate = expandChanged && shouldShowPanel;

    if (shouldAnimate) {
      // Relax constraints first so intermediate sizes are allowed,
      // then enable CSS transition and trigger the resize.
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

  // Enable the CSS transition once isAnimating flips to true and the relaxed
  // constraints have been applied to the DOM (i.e. after React re-renders).
  // We use a layout-effect–like pattern with requestAnimationFrame to ensure
  // the browser has committed the constraint update before we add the
  // transition and trigger the resize.
  useEffect(() => {
    if (!isAnimating) return;
    // Wait one frame so the relaxed min/max sizes are painted,
    // then enable the transition and imperatively trigger the resize.
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

  const renderAssistantMessage = useCallback(() => null, []);
  const renderToolResult = useCallback(() => null, []);

  const agentName = session?.title || 'OpenCode';

  // Mobile
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          {children}
        </div>
        <KortixComputer
          isOpen={isSidePanelOpen && hasToolCalls}
          onClose={handleSidePanelClose}
          toolCalls={toolCalls}
          messages={[]}
          agentStatus={agentStatus}
          currentIndex={currentToolIndex}
          onNavigate={handleSidePanelNavigate}
          externalNavigateToIndex={externalNavIndex}
          renderAssistantMessage={renderAssistantMessage}
          renderToolResult={renderToolResult}
          isLoading={false}
          agentName={agentName}
          disableInitialAnimation={true}
        />
      </div>
    );
  }

  // Desktop: resizable split panel
  return (
    <div className="flex flex-col h-full overflow-hidden bg-background" data-testid="session-layout">
      <div ref={panelGroupRef} className="flex-1 min-h-0 flex overflow-hidden bg-background">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full bg-background"
          style={{ transition: 'none' }}
        >
          {/* Main content panel (SessionChat) */}
          <ResizablePanel
            ref={mainPanelRef}
            defaultSize={shouldShowPanel ? 50 : 100}
            minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 0 : 30) : 100}
            maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 0 : 65) : 100}
            collapsible={isExpanded || isAnimating}
            className={cn(
              "flex flex-col overflow-hidden relative bg-transparent transition-[padding] duration-300 ease-out",
              shouldShowPanel && "pl-3 pr-1.5",
              isExpanded && !isAnimating && "opacity-0 pointer-events-none"
            )}
          >
            <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
              {children}
            </div>
          </ResizablePanel>

          {/* Resizable handle */}
          <ResizableHandle
            withHandle={shouldShowPanel && !isExpanded}
            disabled={!shouldShowPanel || isExpanded}
            className={cn(
              'z-20 transition-opacity duration-300',
              shouldShowPanel && !isExpanded ? 'w-0 opacity-100' : 'w-0 opacity-0 pointer-events-none'
            )}
          />

          {/* Side panel — dual purpose:
                • view='actions' → KortixComputer (tool calls timeline)
                • view='browser' → internal browser (PreviewTabContent)
              The user toggles between them via the header switcher. */}
          <ResizablePanel
            ref={sidePanelRef}
            defaultSize={shouldShowPanel ? 50 : 0}
            minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
            maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
            collapsible={!isExpanded || isAnimating}
            className={cn(
              'relative overflow-hidden bg-background',
              !shouldShowPanel && 'hidden',
            )}
          >
            <div className={cn(
              "h-full transition-[padding] duration-300 ease-out bg-background",
              isExpanded ? "p-0" : "pt-3 pb-6 pr-3 sm:pr-4 pl-1.5"
            )}>
              {/* The header switcher is rendered once and shared across views;
                  the body swaps between KortixComputer and the browser iframe. */}
              {showBrowser ? (
                <SidePanelFrame
                  header={
                    <PanelHeaderSwitcher
                      view={panelView}
                      onChangeView={(v) => setPanelView(sessionId, v)}
                      onClose={handleSidePanelClose}
                    />
                  }
                >
                  <PreviewTabContent tabId={sessionPreviewTabId(sessionId)} />
                </SidePanelFrame>
              ) : (
                <KortixComputer
                  isOpen={isSidePanelOpen && hasToolCalls}
                  onClose={handleSidePanelClose}
                  toolCalls={toolCalls}
                  messages={[]}
                  agentStatus={agentStatus}
                  currentIndex={currentToolIndex}
                  onNavigate={handleSidePanelNavigate}
                  externalNavigateToIndex={externalNavIndex}
                  renderAssistantMessage={renderAssistantMessage}
                  renderToolResult={renderToolResult}
                  isLoading={false}
                  agentName={agentName}
                  disableInitialAnimation={true}
                  sidePanelRef={sidePanelRef}
                  hideTopBar={true}
                  headerSlot={
                    <PanelHeaderSwitcher
                      view={panelView}
                      onChangeView={(v) => setPanelView(sessionId, v)}
                      onClose={handleSidePanelClose}
                    />
                  }
                />
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
});

// ============================================================================
// Side-panel header switcher
// ============================================================================
//
// Sits where the old "Actions" label + close button used to be. Adds a
// two-icon toggle: Actions | Browser. Clicking flips `panelView` in the
// session-browser store, which the parent uses to swap the body content.
function PanelHeaderSwitcher({
  view,
  onChangeView,
  onClose,
}: {
  view: 'actions' | 'browser';
  onChangeView: (next: 'actions' | 'browser') => void;
  onClose: () => void;
}) {
  return (
    <div className="flex-shrink-0 flex items-center justify-between h-10 pl-4 pr-2 border-b border-border/40">
      {/* Plain text tabs with an underline on active — no chip, no fill. */}
      <div role="tablist" aria-label="Side panel view" className="flex items-center gap-5">
        <PanelTabButton
          active={view === 'actions'}
          onClick={() => onChangeView('actions')}
          label="Actions"
        />
        <PanelTabButton
          active={view === 'browser'}
          onClick={() => onChangeView('browser')}
          label="Browser"
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.04] transition-colors cursor-pointer"
            aria-label="Close panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Close panel</TooltipContent>
      </Tooltip>
    </div>
  );
}

function PanelTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center h-10 text-[12px] tracking-tight transition-colors cursor-pointer',
        active
          ? 'text-foreground font-medium'
          : 'text-muted-foreground/70 hover:text-foreground/90',
      )}
    >
      {label}
      {active && (
        <span aria-hidden className="absolute -bottom-px left-0 right-0 h-px bg-foreground" />
      )}
    </button>
  );
}

// Lightweight frame for the browser view so it has the same outer shape
// (header + bordered card) that KortixComputer renders for the actions view.
function SidePanelFrame({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full w-full flex flex-col bg-card overflow-hidden min-w-0 min-h-0 border rounded-[24px]">
      {header}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
