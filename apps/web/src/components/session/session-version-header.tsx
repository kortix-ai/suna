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
import { GitBranch, GitPullRequestArrow, Info, Loader2 } from 'lucide-react';

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
      {/* Compact header row — tabs (left) + version chip & CTA (right). */}
      <div className="flex items-center gap-3 px-4">
        {/* Tabs — All files (default) · Changes (secondary). */}
        <div role="tablist" aria-label="Files view" className="flex items-center gap-5">
          <SubTab active={mode === 'files'} onClick={() => onModeChange('files')} label="All files" />
          <SubTab
            active={mode === 'changes'}
            onClick={() => onModeChange('changes')}
            label="Changes"
            count={changedCount}
          />
        </div>

        {/* Version chip + change-request CTA, right-aligned on the same row.
            On "All files" the verbose framing lives in the tooltip; on
            "Changes" it's spelled out in the explanation strip below. */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            title={`Version ${shortVersionId} · alternative version of ${baseRef}`}
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono text-foreground/80">{shortVersionId}</span>
          </span>
          {hasChanges && (
            <Button
              size="sm"
              className="h-7 shrink-0 gap-1.5"
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
      </div>

      {/* Contextual explanation — only on the Changes tab, where the version
          framing matters most: what these changes are and how they reach main. */}
      {mode === 'changes' && (
        <div className="flex gap-2 border-t border-border/60 bg-muted/15 px-4 py-2.5">
          <Info className="mt-px size-3.5 shrink-0 text-muted-foreground/60" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            What this session changed in version{' '}
            <span className="font-mono text-foreground/80">{shortVersionId}</span> — a separate
            version of{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span>. These edits stay here and
            don&apos;t affect{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span> until you{' '}
            {hasChanges ? (
              <button
                type="button"
                onClick={openChangeRequest}
                disabled={asking}
                className="font-medium text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid disabled:opacity-60"
              >
                open a change request
              </button>
            ) : (
              <span className="font-medium text-foreground/80">open a change request</span>
            )}{' '}
            to merge them in.
          </p>
        </div>
      )}
    </div>
  );
}
