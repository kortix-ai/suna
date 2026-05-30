'use client';

/**
 * SessionVersionHeader — the top of the session's Files / Changes panel.
 *
 * It frames the surface in plain, version-first language: a **separate version**
 * of the project's main version. The agent works here without touching the live
 * version, so changes made in this session aren't in the main version until you
 * open a change request and merge them in.
 *
 * Below the framing sit two plain underline tabs (matching the panel's own tab
 * style): **All files** (default) and **Changes** (the real diff viewer).
 */

import { useParams } from 'next/navigation';
import { GitBranch, GitPullRequestArrow, Loader2 } from 'lucide-react';

import { useGitStatus } from '@/features/files/hooks/use-git-status';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useOpenChangeRequest,
  useSessionBaseRef,
} from '@/components/session/session-changes-shared';

export type SessionPanelMode = 'changes' | 'files';

/** Plain underline tab — mirrors the panel header's PanelTabButton. */
function SubTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // Constant weight in every state — only color + the underline change,
        // so selecting a tab never shifts the layout.
        'relative inline-flex h-9 items-center gap-1.5 text-sm font-medium tracking-tight transition-colors cursor-pointer',
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
        <span aria-hidden className="absolute -bottom-px left-0 right-0 h-px bg-foreground" />
      )}
    </button>
  );
}

export function SessionVersionHeader({
  /** OpenCode chat session id — the agent we message to open the change request. */
  chatSessionId,
  mode,
  onModeChange,
}: {
  chatSessionId?: string;
  mode: SessionPanelMode;
  onModeChange: (mode: SessionPanelMode) => void;
}) {
  // The git branch == the ROUTE session id; the chat session id is passed in.
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const statusQuery = useGitStatus();
  const changedCount = statusQuery.data?.length ?? 0;
  const baseRef = useSessionBaseRef(projectId, gitSessionId);

  // Short, stable handle for this version — the session id is its identity.
  const shortVersionId = gitSessionId ? gitSessionId.slice(0, 8) : '—';
  const { asking, openChangeRequest } = useOpenChangeRequest(chatSessionId, baseRef);

  const hasChanges = changedCount > 0;

  return (
    <div className="flex-shrink-0 border-b border-border/60">
      {/* Version framing — name this version by its id, framed against main. */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 truncate text-sm" title={gitSessionId}>
          <span className="font-medium text-foreground">Version </span>
          <span className="font-mono text-foreground/90">{shortVersionId}</span>
          <span className="text-muted-foreground"> · alternative version of </span>
          <span className="font-mono text-foreground/90">{baseRef}</span>
        </span>
        {hasChanges && (
          <Button
            size="sm"
            className="ml-auto h-7 shrink-0 gap-1.5"
            onClick={openChangeRequest}
            disabled={asking}
          >
            {asking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequestArrow className="size-3.5" />
            )}
            Open change request
          </Button>
        )}
      </div>

      {/* Tabs — All files (default) · Changes (secondary). */}
      <div role="tablist" aria-label="Files view" className="flex items-center gap-5 px-4">
        <SubTab active={mode === 'files'} onClick={() => onModeChange('files')} label="All files" />
        <SubTab
          active={mode === 'changes'}
          onClick={() => onModeChange('changes')}
          label="Changes"
          count={changedCount}
        />
      </div>
    </div>
  );
}
