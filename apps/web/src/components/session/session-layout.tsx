'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { KortixComputer } from '@/components/thread/kortix-computer';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
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

  // Side panel shows for tool calls only now (terminal/desktop moved to right sidebar)
  const shouldShowPanel = isSidePanelOpen && hasToolCalls;

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
    <div className="flex flex-col h-full overflow-hidden">
      <div ref={panelGroupRef} className="flex-1 min-h-0 flex overflow-hidden">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full"
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

          {/* Side panel (KortixComputer — Actions only) */}
          <ResizablePanel
            ref={sidePanelRef}
            defaultSize={shouldShowPanel ? 50 : 0}
            minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
            maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
            collapsible={!isExpanded || isAnimating}
            className={cn(
              'relative overflow-hidden',
              !shouldShowPanel && 'hidden',
            )}
          >
            <div className={cn(
              "h-full transition-[padding] duration-300 ease-out",
              isExpanded ? "p-0" : "pt-3 pb-6 pr-3 sm:pr-4 pl-1.5"
            )}>
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
                  <div className="flex-shrink-0 flex items-center justify-between pl-4 pr-1.5 pt-1.5">
                    <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase select-none">Actions</span>
                    <button
                      onClick={handleSidePanelClose}
                      className="inline-flex items-center justify-center h-8 w-8 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                }
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
});
