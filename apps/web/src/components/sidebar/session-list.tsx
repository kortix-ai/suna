'use client';

import { useState, useMemo, useCallback, startTransition, useEffect, useRef, memo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { normalizeAppPathname, getActiveInstanceIdFromCookie, getCurrentInstanceIdFromPathname, buildInstancePath } from '@/lib/instance-routes';
import {
  MoreHorizontal,
  Trash2,
  Frown,
  MessageCircle,
  Pencil,
  Archive,
  ArchiveRestore,
  ChevronRight,
  ChevronDown,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { restartSandbox } from '@/lib/platform-client';
import { toast } from '@/lib/toast';
import { markRecoveryRequested, useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { useAdminSandboxHealth, useAdminSandboxRepair } from '@/hooks/admin/use-admin-sandboxes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useSidebar } from '@/components/ui/sidebar';
import { DeleteConfirmationDialog } from '@/components/thread/DeleteConfirmationDialog';
import { CompactDialog } from '@/components/session/compact-dialog';
import {
  useOpenCodeSessions,
  useDeleteOpenCodeSession,
  useUpdateOpenCodeSession,
} from '@/hooks/opencode/use-opencode-sessions';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { useDebouncedBusySessions } from '@/hooks/use-debounced-busy-sessions';
import { useSyncStore } from '@/stores/opencode-sync-store';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTabStore, openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';
import { childMapByParent, sortSessions, allDescendantIds } from '@/ui';
import type { Session } from '@/hooks/opencode/use-opencode-sessions';
import { useBackgroundSessionPrefetch, prefetchSession } from '@/hooks/opencode/use-session-prefetch';
import Link from 'next/link';

// ============================================================================
// Session Row — flat, uniform layout for both parent and child sessions
// ============================================================================

interface SessionRowProps {
  session: Session;
  isActive: boolean;
  isBusy: boolean;
  pendingCount: number;
  isChild: boolean;
  /** Total number of direct children for this row */
  childCount?: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClick: (e: React.MouseEvent, sessionId: string) => void;
  onDelete: (sessionId: string, title: string) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onArchive: (sessionId: string) => void;
  onCompact: (sessionId: string) => void;
  onPrefetch?: (sessionId: string) => void;
}

const SessionRow = memo(function SessionRow({
  session,
  isActive,
  isBusy,
  pendingCount,
  isChild,
  childCount = 0,
  isExpanded = false,
  onToggleExpand,
  onClick,
  onDelete,
  onRename,
  onArchive,
  onCompact,
  onPrefetch,
}: SessionRowProps) {
  const [isHovering, setIsHovering] = useState(false);

  const displayTitle = session.title?.includes('@worker')
    ? session.title.replace(/\s*\(@worker\)\s*$/, '')
    : (session.title || 'Untitled');

  return (
    <Link
      href={`/sessions/${session.id}`}
      onClick={(e) => onClick(e, session.id)}
      className="block"
    >
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg cursor-pointer transition-colors duration-150',
          'pr-1.5',
          isChild ? 'py-1 pl-3' : 'py-1.5 pl-3',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        )}
        onMouseEnter={() => {
          setIsHovering(true);
          onPrefetch?.(session.id);
        }}
        onMouseLeave={() => setIsHovering(false)}
      >
        {/* Status dot — busy or pending */}
        {(isBusy || pendingCount > 0) ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex-shrink-0">
                {pendingCount > 0 ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse block" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse block" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {pendingCount > 0
                ? `${pendingCount} ${pendingCount === 1 ? 'question' : 'questions'} waiting`
                : 'Working…'}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {/* Title */}
        <span
          className={cn(
            'flex-1 truncate',
            isChild ? 'text-xs' : 'text-[13px]',
            isActive && 'font-medium',
          )}
        >
          {displayTitle}
        </span>

        {/* Child toggle — subtle count pill stays visible so expanded lists can be collapsed again */}
        {childCount > 0 && onToggleExpand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={isExpanded ? 'Collapse sub-sessions' : 'Expand sub-sessions'}
                className={cn(
                  'flex-shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] tabular-nums transition-colors cursor-pointer',
                  isExpanded
                    ? 'bg-sidebar-accent/80 text-sidebar-foreground'
                    : 'text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-muted-foreground',
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleExpand();
                }}
              >
                {childCount}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {isExpanded ? 'Collapse' : 'Expand'} {childCount} sub-{childCount === 1 ? 'session' : 'sessions'}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Pending badge */}
        {pendingCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-shrink-0 h-4 min-w-4 px-1 rounded-full bg-amber-500/15 text-amber-500 text-[10px] font-medium flex items-center justify-center">
                {pendingCount}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {pendingCount} {pendingCount === 1 ? 'question' : 'questions'} waiting for your input
            </TooltipContent>
          </Tooltip>
        )}

        {/* Context menu — visible on hover */}
        <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'p-0.5 rounded-md hover:bg-sidebar-accent transition-colors duration-150 text-muted-foreground hover:text-sidebar-foreground cursor-pointer',
                  isHovering ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40 p-1">
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRename(session.id, session.title || '');
                }}
              >
                <Pencil className="h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCompact(session.id);
                }}
              >
                <Layers className="h-4 w-4" />
                Compact
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onArchive(session.id);
                }}
              >
                <Archive className="h-4 w-4" />
                Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(session.id, session.title || 'Untitled');
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Link>
  );
});

// ============================================================================
// Session Group — a parent session + its children (if any)
// ============================================================================

interface SessionGroupProps {
  session: Session;
  allSessions: Session[];
  childMap: Map<string, string[]>;
  expandedNodes: Record<string, boolean>;
  onToggleExpand: (sessionId: string) => void;
  isActiveSession: (sessionId: string) => boolean;
  getStatus: (sessionId: string) => { isBusy: boolean; pendingCount: number };
  onClick: (e: React.MouseEvent, sessionId: string) => void;
  onDelete: (sessionId: string, title: string) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onArchive: (sessionId: string) => void;
  onCompact: (sessionId: string) => void;
  onPrefetch?: (sessionId: string) => void;
}

function SessionGroup({
  session,
  allSessions,
  childMap,
  expandedNodes,
  onToggleExpand,
  isActiveSession,
  getStatus,
  onClick,
  onDelete,
  onRename,
  onArchive,
  onCompact,
  onPrefetch,
}: SessionGroupProps) {
  const childIds = childMap.get(session.id);
  const hasChildren = !!childIds && childIds.length > 0;
  const isExpanded = expandedNodes[session.id] ?? false;
  const { isBusy, pendingCount } = getStatus(session.id);

  const childSessions = useMemo(() => {
    if (!childIds) return [];
    return childIds
      .map((id) => allSessions.find((s) => s.id === id))
      .filter((s): s is Session => !!s)
      .sort((a, b) => a.time.created - b.time.created);
  }, [childIds, allSessions]);

  // Recursively collect grandchildren for nested groups
  const renderChild = (child: Session) => {
    const grandchildIds = childMap.get(child.id);
    const hasGrandchildren = !!grandchildIds && grandchildIds.length > 0;
    const childStatus = getStatus(child.id);

    if (hasGrandchildren) {
      // Recursive: this child itself has children, render as nested group
      return (
        <SessionGroup
          key={child.id}
          session={child}
          allSessions={allSessions}
          childMap={childMap}
          expandedNodes={expandedNodes}
          onToggleExpand={onToggleExpand}
          isActiveSession={isActiveSession}
          getStatus={getStatus}
          onClick={onClick}
          onDelete={onDelete}
          onRename={onRename}
          onArchive={onArchive}
          onCompact={onCompact}
          onPrefetch={onPrefetch}
        />
      );
    }

    return (
      <SessionRow
        key={child.id}
        session={child}
        isActive={isActiveSession(child.id)}
        isBusy={childStatus.isBusy}
        pendingCount={childStatus.pendingCount}
        isChild
        onClick={onClick}
        onDelete={onDelete}
        onRename={onRename}
        onArchive={onArchive}
        onCompact={onCompact}
        onPrefetch={onPrefetch}
      />
    );
  };

  // All sessions render with the same SessionRow.
  // Parents keep a persistent toggle so expanded sub-session lists can be closed again.
  return (
    <div>
      <SessionRow
        session={session}
        isActive={isActiveSession(session.id)}
        isBusy={isBusy}
        pendingCount={pendingCount}
        isChild={false}
        childCount={hasChildren ? childSessions.length : 0}
        isExpanded={isExpanded}
        onToggleExpand={hasChildren ? () => onToggleExpand(session.id) : undefined}
        onClick={onClick}
        onDelete={onDelete}
        onRename={onRename}
        onArchive={onArchive}
        onCompact={onCompact}
        onPrefetch={onPrefetch}
      />

      {/* Children — indented under parent with subtle left border */}
      {hasChildren && isExpanded && (
        <div className="ml-5 border-l border-border/30 dark:border-border/20 pl-1">
          {childSessions.map(renderChild)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Session List
// ============================================================================

interface SessionListProps {
  projectId?: string | null;
}

export function SessionList({ projectId }: SessionListProps = {}) {
  const { isMobile, state, setOpenMobile } = useSidebar();
  const rawPathname = usePathname();
  const pathname = normalizeAppPathname(rawPathname);
  const router = useRouter();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; name: string } | null>(null);
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
  const [sessionToArchive, setSessionToArchive] = useState<{ id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [recoveringHost, setRecoveringHost] = useState(false);
  const SESSION_PAGE_SIZE = 50;
  const [displayLimit, setDisplayLimit] = useState(SESSION_PAGE_SIZE);

  const { data: sessions, isLoading, error, refetch } = useOpenCodeSessions();
  const { prefetchOnHover } = useBackgroundSessionPrefetch(sessions);
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteOpenCodeSession();
  const { mutate: updateSession } = useUpdateOpenCodeSession();

  // Auto-refetch sessions when connection recovers from error state
  const connectionStatus = useSandboxConnectionStore((s) => s.status);
  const recoveryPhase = useSandboxConnectionStore((s) => s.recoveryPhase);
  const activeServer = useServerStore((s) => s.servers.find((server) => server.id === s.activeServerId));
  const routeInstanceId = getCurrentInstanceIdFromPathname(rawPathname);
  const activeInstanceId = routeInstanceId || getActiveInstanceIdFromCookie() || activeServer?.instanceId || '';
  const supportsLayeredHealth = activeServer?.provider === 'justavps';
  const { data: adminRole } = useAdminRole({ enabled: !!activeInstanceId });
  const isAdmin = !!adminRole?.isAdmin;
  const adminHealthQuery = useAdminSandboxHealth(
    isAdmin && activeInstanceId ? activeInstanceId : null,
    !!activeInstanceId && isAdmin && supportsLayeredHealth,
  );
  const adminRepairMutation = useAdminSandboxRepair();
  const adminHealth = supportsLayeredHealth ? adminHealthQuery.data : undefined;
  const primaryRepairAction = supportsLayeredHealth
    ? (adminHealth?.recommended_action || 'restart_workload')
    : 'restart_workload';
  const primaryRepairLabel =
    primaryRepairAction === 'restart_runtime' ? 'Restart runtime'
      : primaryRepairAction === 'restart_workload' ? 'Restart workload'
      : primaryRepairAction === 'start_workload' ? 'Start workload'
      : primaryRepairAction === 'start_host' ? 'Start host'
      : primaryRepairAction === 'reboot_host' ? 'Reboot host'
      : 'Repair';
  const prevConnectionRef = useRef(connectionStatus);
  useEffect(() => {
    const prev = prevConnectionRef.current;
    prevConnectionRef.current = connectionStatus;
    if (prev !== 'connected' && connectionStatus === 'connected' && error) {
      refetch();
    }
  }, [connectionStatus, error, refetch]);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [compactSessionId, setCompactSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const statuses = useSyncStore((s) => s.sessionStatus);
  const permissions = useOpenCodePendingStore((s) => s.permissions);
  const questions = useOpenCodePendingStore((s) => s.questions);

  // Debounced busy state — prevents green dot from flickering during reasoning
  const debouncedBusy = useDebouncedBusySessions();

  // Track which tree nodes are manually expanded/collapsed
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>({});

  // Build child map for tree structure (server-side parentID only).
  // Forks are shown as independent top-level sessions — no nesting.
  const childMap = useMemo(() => {
    if (!sessions) return new Map<string, string[]>();
    return childMapByParent(sessions);
  }, [sessions]);

  // Count pending for a single session (not recursive)
  // For questions, count the total number of individual questions across all requests
  const countPendingForSession = useCallback(
    (sid: string) => {
      const permCount = Object.values(permissions).filter((p) => p.sessionID === sid).length;
      const qCount = Object.values(questions)
        .filter((q) => q.sessionID === sid)
        .reduce((sum, q) => sum + (q.questions?.length || 1), 0);
      return permCount + qCount;
    },
    [permissions, questions],
  );

  // Aggregate pending count: session's own + all descendants
  const getPendingCount = useCallback(
    (sessionId: string) => {
      let total = countPendingForSession(sessionId);
      const descendants = allDescendantIds(childMap, sessionId);
      for (const descId of descendants) {
        total += countPendingForSession(descId);
      }
      return total;
    },
    [countPendingForSession, childMap],
  );

  // Check if any descendant is busy or has pending items (for auto-expand)
  const hasActiveDescendant = useCallback(
    (sessionId: string) => {
      const descendants = allDescendantIds(childMap, sessionId);
      for (const descId of descendants) {
        if (statuses[descId]?.type === 'busy') return true;
        if (countPendingForSession(descId) > 0) return true;
      }
      return false;
    },
    [childMap, statuses, countPendingForSession],
  );

  // Extract the active session ID from the URL so we can auto-expand its parent
  const activeSessionId = useMemo(() => {
    const match = pathname?.match(/^\/sessions\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  // Compute expanded state: manual overrides take priority, otherwise auto-expand
  // when a descendant is active (busy/pending) or when the user is viewing a child session.
  const expandedNodes = useMemo(() => {
    const result: Record<string, boolean> = {};
    if (!sessions) return result;
    for (const session of sessions) {
      const childIds = childMap.get(session.id);
      if (!childIds || childIds.length === 0) continue;
      if (session.id in manualExpanded) {
        result[session.id] = manualExpanded[session.id];
      } else {
        // Auto-expand if any descendant is active (busy/pending)
        // or if the user is currently viewing a descendant session
        const descendants = allDescendantIds(childMap, session.id);
        const viewingDescendant = !!activeSessionId && descendants.includes(activeSessionId);
        result[session.id] = hasActiveDescendant(session.id) || viewingDescendant;
      }
    }
    return result;
  }, [sessions, childMap, manualExpanded, hasActiveDescendant, activeSessionId]);

  const handleToggleExpand = useCallback((sessionId: string) => {
    setManualExpanded((prev) => ({
      ...prev,
      [sessionId]: !(prev[sessionId] ?? expandedNodes[sessionId] ?? false),
    }));
  }, [expandedNodes]);

  // Get status for a session (busy + pending)
  const getStatus = useCallback(
    (sessionId: string) => {
      const pendingCount = getPendingCount(sessionId);
      const isBusy =
        pendingCount === 0 &&
        (debouncedBusy[sessionId] ||
          statuses[sessionId]?.type === 'busy' ||
          statuses[sessionId]?.type === 'retry');
      return { isBusy: !!isBusy, pendingCount };
    },
    [getPendingCount, debouncedBusy, statuses],
  );

  // Filter to root sessions only for the top-level list.
  const rootSessions = useMemo(() => {
    if (!sessions) return [];
    let list = sessions.filter((s) => !s.parentID && !(s.time as any).archived);
    if (projectId !== null && projectId !== undefined) {
      list = list.filter((s) => s.projectID === projectId);
    }
    const baseSorted = [...list].sort(sortSessions(Date.now()));
    return baseSorted.sort((a, b) => {
      const aPending = getPendingCount(a.id);
      const bPending = getPendingCount(b.id);
      if (aPending > 0 && bPending === 0) return -1;
      if (bPending > 0 && aPending === 0) return 1;
      const aIsBusy = aPending === 0 && (debouncedBusy[a.id] || statuses[a.id]?.type === 'busy') ? 1 : 0;
      const bIsBusy = bPending === 0 && (debouncedBusy[b.id] || statuses[b.id]?.type === 'busy') ? 1 : 0;
      if (aIsBusy > bIsBusy) return -1;
      if (bIsBusy > aIsBusy) return 1;
      return 0;
    });
  }, [sessions, projectId, debouncedBusy, statuses, getPendingCount]);

  // Archived sessions
  const archivedSessions = useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((s) => !!(s.time as any).archived)
      .sort((a, b) => ((b.time as any).archived || 0) - ((a.time as any).archived || 0));
  }, [sessions]);

  const handleSessionClick = (e: React.MouseEvent, sessionId: string) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (isMobile) setOpenMobile(false);

    const session = rootSessions.find(s => s.id === sessionId) ||
      sessions?.find(s => s.id === sessionId);
    const parentId = session?.parentID;
    openTabAndNavigate({
      id: sessionId,
      title: session?.title || 'Session',
      type: 'session',
      href: `/sessions/${sessionId}`,
      ...(parentId && { parentSessionId: parentId }),
      serverId: useServerStore.getState().activeServerId,
    });
  };

  const handleDeleteSession = (sessionId: string, title: string) => {
    setSessionToDelete({ id: sessionId, name: title });
    setIsDeleteDialogOpen(true);
  };

  const handleRenameSession = (sessionId: string, currentTitle: string) => {
    setRenameSessionId(sessionId);
    setRenameValue(currentTitle);
  };

  const confirmRename = () => {
    if (!renameSessionId || !renameValue.trim()) {
      setRenameSessionId(null);
      return;
    }
    updateSession(
      { sessionId: renameSessionId, title: renameValue.trim() },
    );
    setRenameSessionId(null);
  };

  const handleArchiveSession = (sessionId: string) => {
    const session = sessions?.find((s) => s.id === sessionId);
    setSessionToArchive({ id: sessionId, name: session?.title || 'Untitled' });
    setIsArchiveDialogOpen(true);
  };

  const confirmArchive = () => {
    if (!sessionToArchive) return;
    setIsArchiveDialogOpen(false);
    const isActive = pathname?.includes(sessionToArchive.id);

    const tabState = useTabStore.getState();
    if (tabState.tabs[sessionToArchive.id]) {
      tabState.closeTab(sessionToArchive.id);
    }

    updateSession(
      { sessionId: sessionToArchive.id, archived: true },
      {
        onSuccess: () => {
          if (isActive) {
            const nextState = useTabStore.getState();
            const nextTab = nextState.activeTabId ? nextState.tabs[nextState.activeTabId] : null;
            router.push(nextTab?.href || '/dashboard');
          }
        },
      },
    );
    setSessionToArchive(null);
  };

  const handleUnarchiveSession = (sessionId: string) => {
    updateSession({ sessionId, archived: false });
  };

  const handleCompactSession = (sessionId: string) => {
    setCompactSessionId(sessionId);
  };

  const handleRecoverHost = useCallback(async () => {
    if (!activeInstanceId || recoveringHost) return;
    setRecoveringHost(true);
    const phase = primaryRepairAction === 'restart_runtime'
      ? 'restarting_runtime'
      : primaryRepairAction === 'reboot_host' || primaryRepairAction === 'start_host'
        ? 'restarting_host'
        : 'restarting_workload';
    markRecoveryRequested(phase);
    try {
      if (supportsLayeredHealth && isAdmin && activeInstanceId) {
        await adminRepairMutation.mutateAsync({ sandboxId: activeInstanceId, action: primaryRepairAction });
      } else {
        await restartSandbox(activeInstanceId);
      }
      toast.success(`${primaryRepairLabel} initiated.`);
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to run repair action');
    } finally {
      setTimeout(() => setRecoveringHost(false), 15_000);
    }
  }, [activeInstanceId, adminRepairMutation, isAdmin, primaryRepairAction, primaryRepairLabel, recoveringHost, refetch, supportsLayeredHealth]);

  const confirmDelete = () => {
    if (!sessionToDelete) return;
    setIsDeleteDialogOpen(false);
    const isActive = pathname?.includes(sessionToDelete.id);

    const tabState = useTabStore.getState();
    const fallback = buildInstancePath(getActiveInstanceIdFromCookie() || '', '/dashboard');
    if (tabState.tabs[sessionToDelete.id]) {
      const nextTabId = tabState.closeTab(sessionToDelete.id);
      if (isActive) {
        const nextTab = nextTabId ? useTabStore.getState().tabs[nextTabId] : null;
        router.push(nextTab?.href || fallback);
      }
    } else if (isActive) {
      router.push(fallback);
    }

    deleteSession(sessionToDelete.id);
    setSessionToDelete(null);
  };

  const isActiveSession = (sessionId: string) =>
    pathname?.includes(sessionId) || false;

  if (state === 'collapsed' && !isMobile) return null;

  const sharedGroupProps = {
    allSessions: sessions || [],
    childMap,
    expandedNodes,
    onToggleExpand: handleToggleExpand,
    isActiveSession,
    getStatus,
    onClick: handleSessionClick,
    onDelete: handleDeleteSession,
    onRename: handleRenameSession,
    onArchive: handleArchiveSession,
    onCompact: handleCompactSession,
    onPrefetch: prefetchOnHover,
  };

  return (
    <div className="flex flex-col pl-8">
      {/* Archived sessions toggle */}
      {archivedSessions.length > 0 && !isLoading && !error && (
        <div className="px-2 pb-1">
          <Button
            onClick={() => setShowArchived((v) => !v)}
            variant="ghost"
            className="flex items-center gap-1.5 w-full px-3 py-1.5 h-auto rounded-lg text-xs text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent justify-start"
          >
            <Archive className="size-3" />
            <span>Archived</span>
            <span className="ml-auto text-[10px] tabular-nums bg-muted px-1.5 py-0.5 rounded-full">{archivedSessions.length}</span>
            {showArchived ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </Button>
          {showArchived && (
            <div className="space-y-0.5 mt-0.5 mb-1">
              {archivedSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors duration-150 group cursor-pointer"
                >
                  <span className="flex-1 truncate text-xs">
                    {session.title || 'Untitled'}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleUnarchiveSession(session.id)}
                        className="p-0.5 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors cursor-pointer"
                      >
                        <ArchiveRestore className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">
                      Unarchive
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleDeleteSession(session.id, session.title || 'Untitled')}
                        className="p-0.5 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors cursor-pointer"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="text-xs">
                      Delete
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session list */}
      <div className="px-2 pb-2">
        {isLoading ? (
          <div className="space-y-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded-lg">
                <div className="h-3.5 w-24 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <Frown className="h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              {recoveryPhase === 'restarting_host'
                ? 'Rebooting host'
                : recoveryPhase === 'restarting_workload'
                  ? 'Restarting workload'
                  : recoveryPhase === 'restarting_runtime'
                    ? 'Restarting runtime services'
                : adminHealth?.layers.runtime.status === 'degraded' && adminHealth.layers.host.status === 'healthy' && adminHealth.layers.workload.status === 'healthy'
                  ? 'Runtime services unavailable'
                : adminHealth?.layers.workload.status !== 'healthy'
                  ? 'Workspace container unavailable'
                : connectionStatus === 'unreachable'
                  ? 'Workspace offline'
                  : 'Failed to connect'}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[220px] leading-relaxed">
              {recoveryPhase === 'restarting_host'
                ? 'Host reboot accepted. Waiting for the machine and workspace services to come back online.'
                : recoveryPhase === 'restarting_workload'
                  ? 'Workload restart accepted. Waiting for the container and workspace services to come back online.'
                : recoveryPhase === 'restarting_runtime'
                    ? 'Runtime restart accepted. Waiting for core services to come back online.'
                : adminHealth?.layers.runtime.status === 'degraded' && adminHealth.layers.host.status === 'healthy' && adminHealth.layers.workload.status === 'healthy'
                  ? 'Host and workload are healthy, but runtime services inside the workspace are failing. Restart the runtime layer first.'
                : adminHealth?.layers.workload.status !== 'healthy'
                  ? 'The host is up, but the managed workload service or container is unhealthy. Restart the workload layer first.'
                : connectionStatus === 'unreachable'
                ? 'We cannot reach this instance right now. Restart the workload to bring the sandbox services back online.'
                : 'Could not reach server'}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {connectionStatus === 'unreachable' && activeServer?.provider === 'justavps' && activeInstanceId ? (
                <Button
                  onClick={() => void handleRecoverHost()}
                  variant="default"
                  size="sm"
                  disabled={recoveringHost}
                >
                  {recoveringHost ? 'Restarting…' : primaryRepairLabel}
                </Button>
              ) : null}
              <Button
                onClick={() => refetch()}
                variant="muted"
                size="sm"
              >
                Retry
              </Button>
            </div>
          </div>
        ) : rootSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <MessageCircle className="h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No sessions yet</p>
            <p className="text-xs text-muted-foreground mt-1">Start a new session to get going</p>
          </div>
        ) : (
          <div className="space-y-px">
            {/* Pending sessions — need user input */}
            {rootSessions.filter((s) => getPendingCount(s.id) > 0).map((session) => (
              <SessionGroup
                key={session.id}
                session={session}
                {...sharedGroupProps}
              />
            ))}

            {/* Remaining sessions (paginated) */}
            {(() => {
              const remaining = rootSessions.filter((s) => getPendingCount(s.id) === 0);
              const visible = remaining.slice(0, displayLimit);
              const hasMore = remaining.length > displayLimit;
              return (
                <>
                  {visible.map((session) => (
                    <SessionGroup
                      key={session.id}
                      session={session}
                      {...sharedGroupProps}
                    />
                  ))}
                  {hasMore && (
                    <Button
                      type="button"
                      onClick={() => setDisplayLimit((l) => l + SESSION_PAGE_SIZE)}
                      variant="ghost"
                      className="w-full h-auto py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded-lg"
                    >
                      Show more ({remaining.length - displayLimit} remaining)
                    </Button>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {sessionToDelete && (
        <DeleteConfirmationDialog
          isOpen={isDeleteDialogOpen}
          onClose={() => setIsDeleteDialogOpen(false)}
          onConfirm={confirmDelete}
          threadName={sessionToDelete.name}
          isDeleting={isDeleting}
        />
      )}

      {/* Archive confirmation dialog */}
      <AlertDialog open={isArchiveDialogOpen} onOpenChange={setIsArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive session</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to archive{' '}
              <span className="font-semibold">&ldquo;{sessionToArchive?.name}&rdquo;</span>?
              <br />
              You can restore it later from the archived list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmArchive();
              }}
              className="cursor-pointer"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Compact dialog */}
      {compactSessionId && (
        <CompactDialog
          sessionId={compactSessionId}
          open={!!compactSessionId}
          onOpenChange={(open) => { if (!open) setCompactSessionId(null); }}
        />
      )}

      {/* Rename dialog */}
      <Dialog
        open={!!renameSessionId}
        onOpenChange={(open) => { if (!open) setRenameSessionId(null); }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              Enter a new name for this session.
            </DialogDescription>
          </DialogHeader>
          <Input type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRename();
            }}
            autoFocus
            placeholder="Session title..."
          />
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenameSessionId(null)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={confirmRename}
              className="cursor-pointer"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
