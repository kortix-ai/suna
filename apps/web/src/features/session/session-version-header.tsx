'use client';

/**
 * Chrome for the session panel's Files surface.
 *
 * Two plain underline tabs — **All files** (default) and **Changes** (the real
 * diff viewer) — plus, on the Changes tab only, the action that gets this
 * version's work reviewed.
 *
 * On All files the tabs do NOT get a bar of their own: they are handed to the
 * explorer as its row's `leading` slot, so the panel shows one row, not two.
 * See `SessionFilesExplorer`.
 *
 * What used to live here and no longer does:
 *   • a `⧉ a1b2c3d4` version chip on every tab — the id only means something
 *     next to the changes it labels, so it moved into the Changes line below.
 *   • an "Open change request" button on every tab — it is meaningless on
 *     All files, and "change request" is jargon the rest of Files does not
 *     use. It is now **Propose changes**, on the tab that has changes.
 *   • a four-line `InfoBanner` paragraph re-explaining branches. One line.
 */

import { useParams } from 'next/navigation';
import { useRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';

import {
  useOpenChangeRequest,
  useSessionBaseRef,
  useSessionChanges,
} from '@/features/session/session-changes-shared';
import { cn } from '@/lib/utils';

export type SessionPanelMode = 'changes' | 'files';

export type { SessionPanelMode as SessionVersionHeaderMode };

/** Tab order — drives both render order and arrow-key traversal. */
const TAB_ORDER: SessionPanelMode[] = ['files', 'changes'];

/** Stable DOM id for a tab, derived from the panel id the parent owns. */
export function sessionVersionTabId(panelId: string, mode: SessionPanelMode) {
  return `${panelId}-tab-${mode}`;
}

/** Plain underline tab — mirrors the panel header's PanelTabButton. */
function SubTab({
  active,
  onClick,
  label,
  count,
  id,
  controls,
  tabRef,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  id: string;
  controls: string;
  tabRef: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      // Roving tabIndex: the strip is one tab stop, arrows move within it.
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        // Constant weight in every state — only color + the underline change,
        // so selecting a tab never shifts the layout.
        'relative inline-flex h-11 cursor-pointer items-center gap-1.5 text-sm font-medium tracking-tight transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground/90',
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <Badge size="sm" variant={active ? 'secondary' : 'outline'} className="tabular-nums">
          {count}
        </Badge>
      )}
      {active && (
        <span aria-hidden className="bg-foreground absolute right-0 -bottom-px left-0 h-px" />
      )}
    </button>
  );
}

interface TabsProps {
  mode: SessionPanelMode;
  onModeChange: (mode: SessionPanelMode) => void;
  /** DOM id of the tab panel this strip controls — owned by the parent. */
  panelId: string;
}

/**
 * The tab strip on its own, with no bar of its own — it is dropped into a row
 * the host already draws.
 */
export function SessionFilesTabs({ mode, onModeChange, panelId }: TabsProps) {
  // The SAME query the Changes panel below renders — one array, so the badge
  // and the body cannot contradict each other.
  const { count: changedCount } = useSessionChanges();

  const tabRefs = useRef<Partial<Record<SessionPanelMode, HTMLButtonElement | null>>>({});
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = TAB_ORDER.indexOf(mode);
    let nextIndex = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (current + 1) % TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_ORDER.length - 1;
    }
    if (nextIndex === -1) return;
    event.preventDefault();
    const next = TAB_ORDER[nextIndex];
    onModeChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Files"
      className="flex min-w-0 items-center gap-5"
      onKeyDown={handleTabKeyDown}
    >
      <SubTab
        active={mode === 'files'}
        onClick={() => onModeChange('files')}
        id={sessionVersionTabId(panelId, 'files')}
        controls={panelId}
        tabRef={(node) => {
          tabRefs.current.files = node;
        }}
        label="All files"
      />
      <SubTab
        active={mode === 'changes'}
        onClick={() => onModeChange('changes')}
        id={sessionVersionTabId(panelId, 'changes')}
        controls={panelId}
        tabRef={(node) => {
          tabRefs.current.changes = node;
        }}
        label="Changes"
        count={changedCount}
      />
    </div>
  );
}

/**
 * The Changes tab's own row: the same tabs, plus **Propose changes** — the one
 * action this surface exists to lead to — and a single line saying where these
 * edits currently live.
 */
export function SessionChangesHeader({
  /** OpenCode chat session id — the agent we message to propose the changes. */
  chatSessionId,
  mode,
  onModeChange,
  panelId,
}: TabsProps & { chatSessionId?: string }) {
  // The git branch == the ROUTE session id; the chat session id is passed in.
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const { count: changedCount } = useSessionChanges();
  const baseRef = useSessionBaseRef(projectId, gitSessionId);

  // Short, stable handle for this version — the session id is its identity.
  const shortVersionId = gitSessionId ? gitSessionId.slice(0, 8) : '—';
  const { asking, openChangeRequest } = useOpenChangeRequest(chatSessionId, baseRef);

  const hasChanges = changedCount > 0;

  return (
    <div className="border-border/60 shrink-0 border-b">
      <div className="flex h-11 items-center gap-3 px-2">
        <SessionFilesTabs mode={mode} onModeChange={onModeChange} panelId={panelId} />

        {hasChanges && (
          <Button
            size="sm"
            className="ml-auto shrink-0 gap-1.5 active:scale-[0.96]"
            onClick={openChangeRequest}
            disabled={asking}
          >
            {asking ? <Loading className="size-3.5 shrink-0" /> : null}
            Propose changes
          </Button>
        )}
      </div>

      <p className="text-muted-foreground px-2 pb-2 text-xs text-pretty">
        Version <span className="text-foreground/80 font-mono">{shortVersionId}</span> — edits stay
        out of <span className="text-foreground/80 font-mono">{baseRef}</span> until you propose
        them for review.
      </p>
    </div>
  );
}
