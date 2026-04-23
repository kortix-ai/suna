'use client';

import * as React from 'react';
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  ChevronRight,
  ChevronLeft,
  SquarePen,
  ListTree,
  ChevronDown,
  Search,
  ArrowDownToLine,
  Sparkles,
  Bug,
  Zap,
  X,
  Loader2,
  History,
  ArrowRightLeft,
  CheckCircle2,
  FolderOpen,
  FolderKanban,
  AlertCircle,
  Copy,
  ShieldAlert,
} from 'lucide-react';
import posthog from 'posthog-js';

import { SessionList } from '@/components/sidebar/session-list';
import { useLegacyThreads, useMigrateAllLegacyThreads, useMigrateAllStatus } from '@/hooks/legacy/use-legacy-threads';
import { useGlobalSandboxUpdate } from '@/hooks/platform/use-global-sandbox-update';
import { useUpdateDialogStore } from '@/stores/update-dialog-store';

import { UserMenu } from '@/components/sidebar/user-menu';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ThreadIcon } from '@/components/sidebar/thread-icon';

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useAdminRole } from '@/hooks/admin';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { isBillingEnabled } from '@/lib/config';

import { useCreateOpenCodeSession, useOpenCodeSessions } from '@/hooks/opencode/use-opencode-sessions';
import { useKortixProjects, type KortixProject } from '@/hooks/kortix/use-kortix-projects';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { buildInstancePath, getCurrentInstanceIdFromPathname, getActiveInstanceIdFromCookie, normalizeAppPathname } from '@/lib/instance-routes';
import { createClient } from '@/lib/supabase/client';
import { useSandbox } from '@/hooks/platform/use-sandbox';
import { getSandboxUrl, reactivateSandbox, listSandboxes, type SandboxInfo } from '@/lib/platform-client';
import { authenticatedFetch } from '@/lib/auth-token';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';

interface SidebarSandboxConfigProblem {
  source: string;
  scope: 'global' | 'local' | 'env' | 'managed' | 'remote' | string;
  kind: 'json' | 'schema' | 'substitution' | string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

interface SidebarSandboxConfigStatus {
  valid: boolean;
  loadedSources: string[];
  skippedSources: string[];
  problems: SidebarSandboxConfigProblem[];
}

interface SidebarProjectSummary {
  id: string;
  name: string;
  path: string;
}

function isSidebarSandboxConfigStatus(value: unknown): value is SidebarSandboxConfigStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.valid === 'boolean'
    && Array.isArray(candidate.loadedSources)
    && Array.isArray(candidate.skippedSources)
    && Array.isArray(candidate.problems);
}

async function sidebarSandboxRequestJson<T>(sandboxUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${sandboxUrl.replace(/\/+$/, '')}${path}`, {
    signal: AbortSignal.timeout(10_000),
    ...init,
  }, { retryOnAuthError: false });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data
      ? String((data as Record<string, unknown>).error)
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function pickSidebarConfigFixProject(projects: SidebarProjectSummary[]): SidebarProjectSummary | null {
  return projects.find((project) => project.path === '/workspace') ?? projects[0] ?? null;
}

function buildSidebarConfigFixPrompt(sandbox: SandboxInfo, status: SidebarSandboxConfigStatus): string {
  const header = `Inspect and repair the ignored OpenCode config sources for instance "${sandbox.name || sandbox.sandbox_id}".`;
  const explanation = 'OpenCode is running in fail-soft mode and skipped the invalid sources below instead of crashing the runtime.';
  const problems = status.problems.map((problem, index) => {
    const issueLines = (problem.issues ?? []).map((issue) => issue.message).filter(Boolean);
    return [
      `${index + 1}. Source: ${problem.source}`,
      `   Scope: ${problem.scope}`,
      `   Kind: ${problem.kind}`,
      `   Message: ${problem.message || 'No message provided.'}`,
      ...(issueLines.length ? issueLines.map((line) => `   Detail: ${line}`) : []),
    ].join('\n');
  }).join('\n\n');

  return [
    header,
    explanation,
    '',
    problems,
    '',
    'Repair the invalid source in place. If the problem is a legacy top-level `models` array, migrate it to valid `provider` config.',
    'When finished, verify `GET /config/status` returns `{"valid": true, "skippedSources": []}` and the runtime stays healthy.',
  ].join('\n');
}

// ============================================================================
// Floating Mobile Menu Button
// ============================================================================
// Collapsed Icon Button — tooltip for simple buttons, hover flyout for lists
// ============================================================================

interface CollapsedIconButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  flyoutContent?: React.ReactNode;
  disabled?: boolean;
  isActive?: boolean;
}

function CollapsedIconButton({ icon, label, onClick, flyoutContent, disabled, isActive }: CollapsedIconButtonProps) {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlyoutOpen(false), 180);
  }, []);

  const cancelClose = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Position flyout to the right of the button
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (flyoutOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.top, left: r.right + 8 });
    }
  }, [flyoutOpen]);

  // Close on Escape
  useEffect(() => {
    if (!flyoutOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlyoutOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flyoutOpen]);

  // Close on click outside
  useEffect(() => {
    if (!flyoutOpen) return;
    const onDown = (e: PointerEvent) => {
      if (btnRef.current?.contains(e.target as Node) || flyoutRef.current?.contains(e.target as Node)) return;
      setFlyoutOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [flyoutOpen]);

  // The button — styled ONLY via CSS :hover and isActive prop.
  // flyoutOpen never touches the className. This is the whole point.
  const btnClass = cn(
    'flex items-center justify-center w-full py-2 rounded-lg cursor-pointer',
    'transition-colors duration-150 ease-out',
    isActive
      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
      : 'text-sidebar-foreground hover:bg-sidebar-accent',
    disabled && 'opacity-50 cursor-not-allowed',
  );

  // --- Flyout variant: NO tooltip, the flyout panel IS the expanded label ---
  if (flyoutContent) {
    return (
      <>
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={disabled}
          className={btnClass}
          onMouseEnter={() => { cancelClose(); setFlyoutOpen(true); }}
          onMouseLeave={scheduleClose}
        >
          {icon}
        </button>
        {flyoutOpen && typeof document !== 'undefined' && createPortal(
          <div
            ref={flyoutRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 10001 }}
            className="w-[260px] max-h-[60vh] overflow-hidden flex flex-col rounded-xl border bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-[0.98] slide-in-from-left-1 duration-100"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            {flyoutContent}
          </div>,
          document.body,
        )}
      </>
    );
  }

  // --- Simple variant (tooltip only) ---
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={btnRef}
          onClick={onClick}
          disabled={disabled}
          className={btnClass}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Sessions Flyout Content
// ============================================================================

function SessionsFlyout({ collapsed }: { collapsed?: boolean }) {
  const pathname = normalizeAppPathname(usePathname());
  const { data: sessions } = useOpenCodeSessions();
  const permissions = useOpenCodePendingStore((s) => s.permissions);
  const questions = useOpenCodePendingStore((s) => s.questions);

  const rootSessions = React.useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((s) => !s.parentID && !(s.time as any).archived)
      .sort((a, b) => b.time.updated - a.time.updated);
  }, [sessions]);

  const getPendingCount = (id: string) => {
    return Object.values(permissions).filter((p) => p.sessionID === id).length
      + Object.values(questions).filter((q) => q.sessionID === id).length;
  };

  return (
    <div className="overflow-y-auto py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      {rootSessions.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">No sessions yet</div>
      ) : (
        rootSessions.map((session) => {
          const active = pathname === `/sessions/${session.id}`;
          const pending = getPendingCount(session.id);
          return (
            <button
              key={session.id}
              onClick={() => {
                openTabAndNavigate({
                  id: session.id,
                  title: session.title || 'Session',
                  type: 'session',
                  href: `/sessions/${session.id}`,
                  serverId: useServerStore.getState().activeServerId,
                });
              }}
              className={cn(
                'flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] cursor-pointer transition-colors duration-100',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              {!collapsed && <ThreadIcon iconName={(session as any).icon} className="flex-shrink-0" size={14} />}
              <span className="flex-1 truncate text-left">{session.title || 'Untitled'}</span>
              {pending > 0 && (
                <span className="flex-shrink-0 h-4 min-w-4 px-1 rounded-full bg-amber-500/15 text-amber-500 text-[10px] font-semibold flex items-center justify-center">
                  {pending}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

// ============================================================================
// Projects Flyout Content
// ============================================================================

function ProjectsFlyout() {
  const { data: projects } = useKortixProjects();

  const sorted = React.useMemo(() => {
    if (!projects || !Array.isArray(projects)) return [];
    return [...projects].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [projects]);

  return (
    <div className="overflow-y-auto py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      {sorted.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">No projects yet</div>
      ) : (
        sorted.map((project) => (
          <button
            key={project.id}
            onClick={() => {
              openTabAndNavigate({
                id: `project:${project.id}`,
                title: project.name,
                type: 'project',
                href: `/projects/${encodeURIComponent(project.id)}`,
              });
            }}
            className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] cursor-pointer transition-colors duration-100 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <span className="flex-1 truncate text-left">{project.name}</span>
            {(project.sessionCount ?? 0) > 0 && (
              <span className="text-[10px] text-muted-foreground/40 tabular-nums">{project.sessionCount}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

// ============================================================================
// User Profile Section
// ============================================================================

// ============================================================================
// Sidebar Update Indicator
// ============================================================================

const changeTypeIcon: Record<string, typeof Sparkles> = {
  feature: Sparkles,
  fix: Bug,
  improvement: Zap,
};
const changeTypeColor: Record<string, string> = {
  feature: 'text-emerald-500',
  fix: 'text-red-400',
  improvement: 'text-blue-400',
};

function SidebarUpdateIndicator({ collapsed }: { collapsed: boolean }) {
  const {
    updateAvailable, latestVersion, currentChannel, changelog,
    isUpdating, updateResult, isBackingUp, isDestructive, phaseProgress,
    hasActiveUpdate, phase, phaseMessage, updateErrorMessage, canCancel, isCancelling, cancel,
  } = useGlobalSandboxUpdate();
  const openDialog = useUpdateDialogStore((s) => s.openDialog);
  const router = useRouter();
  const [dismissed, setDismissed] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  const dismissKey = `sidebar-update-dismissed-${latestVersion}`;

  React.useEffect(() => {
    setMounted(true);
    try {
      if (localStorage.getItem(dismissKey) === 'true') setDismissed(true);
    } catch {}
  }, [dismissKey]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissed(true);
    try { localStorage.setItem(dismissKey, 'true'); } catch {}
  };

  const navigateToChangelog = () => {
    openTabAndNavigate(
      { id: 'page:/changelog', title: 'Changelog', type: 'page', href: '/changelog' },
      router,
    );
  };

  // Hide only when there's truly nothing to show: no update available, not
  // dismissed, and no in-progress work. An active backup must keep this card
  // visible even if the user previously dismissed the "update available" toast.
  const showBackupCard = isBackingUp;
  if (!mounted || (!updateAvailable && !hasActiveUpdate) || (dismissed && !hasActiveUpdate) || updateResult?.success) return null;

  // ── Collapsed state: icon with pulse dot ──
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <button
          onClick={hasActiveUpdate ? undefined : navigateToChangelog}
          className="relative p-2 rounded-lg hover:bg-primary/10 transition-colors cursor-pointer"
          title={hasActiveUpdate ? `${phaseMessage || phase} (${phaseProgress}%)` : `v${latestVersion} available`}
        >
          {hasActiveUpdate
            ? <Loader2 className="h-4 w-4 text-primary animate-spin" />
            : <ArrowDownToLine className="h-4 w-4 text-primary" />}
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary animate-pulse" />
        </button>
      </div>
    );
  }

  if (showBackupCard) {
    return (
      <div className="rounded-xl border border-primary/15 bg-muted/40 overflow-hidden">
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Loader2 className="h-3.5 w-3.5 text-primary animate-spin flex-shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate min-w-0">
            Backing up sandbox
          </span>
          <span className="flex-1" />
          <span className="text-[10px] text-muted-foreground flex-shrink-0">v{latestVersion}</span>
        </div>
        <p className="px-3 pb-2 text-[11px] text-muted-foreground leading-tight">
          {phaseMessage || 'You can keep using your machine. Update will continue automatically once the backup completes.'}
        </p>
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <div className="h-1.5 flex-1 rounded-full bg-foreground/10 overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${phaseProgress}%` }} />
          </div>
          {canCancel && (
            <Button size="toolbar" variant="muted" onClick={() => cancel()} disabled={isCancelling}>
              {isCancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] overflow-hidden">
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Bug className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate min-w-0">Update failed</span>
          <span className="flex-1" />
          <span className="text-[10px] text-muted-foreground flex-shrink-0">v{latestVersion}</span>
        </div>
        <p className="px-3 pb-2 text-[11px] text-muted-foreground leading-tight line-clamp-3">
          {updateErrorMessage || phaseMessage || 'Something went wrong during the update.'}
        </p>
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
          <Button onClick={() => openDialog()} variant="default" size="toolbar" className="flex-1">
            Retry
          </Button>
          <Button onClick={navigateToChangelog} variant="muted" size="toolbar">Details</Button>
        </div>
      </div>
    );
  }

  if (isDestructive) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2.5 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-amber-700 dark:text-amber-300 truncate">
            {phaseMessage || `Installing v${latestVersion}…`}
          </span>
          <span className="block text-[10px] text-amber-700/70 dark:text-amber-300/70 truncate">
            {phase} · {phaseProgress}%
          </span>
        </div>
      </div>
    );
  }

  // ── Expanded state: rich card ──
  const changes = changelog?.changes ?? [];
  const previewChanges = changes.slice(0, 3);
  const remaining = changes.length - 3;

  return (
    <div className="rounded-xl border border-primary/15 bg-primary/[0.03] overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span className="text-xs font-semibold text-foreground truncate min-w-0">
          {currentChannel === 'dev' ? 'New dev build' : 'New Kortix version'}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-muted-foreground flex-shrink-0">v{latestVersion}</span>
        <button
          onClick={handleDismiss}
          className="p-0.5 rounded hover:bg-muted/80 transition-colors cursor-pointer flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3 text-muted-foreground/60" />
        </button>
      </div>

      {/* Change list */}
      {previewChanges.length > 0 && (
        <div className="px-3 pb-1.5 space-y-0.5">
          {previewChanges.map((change, i) => {
            const Icon = changeTypeIcon[change.type] ?? Zap;
            const color = changeTypeColor[change.type] ?? 'text-muted-foreground';
            return (
              <div key={i} className="flex items-start gap-1.5">
                <Icon className={cn('h-3 w-3 mt-[1px] flex-shrink-0', color)} />
                <span className="text-[11px] text-muted-foreground leading-tight line-clamp-1">{change.text}</span>
              </div>
            );
          })}
          {remaining > 0 && (
            <button
              onClick={navigateToChangelog}
              className="text-[10px] text-primary/70 hover:text-primary font-medium pl-[18px] cursor-pointer transition-colors"
            >
              +{remaining} more
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        {!hasActiveUpdate ? (
          <Button
            onClick={() => openDialog()}
            variant="default"
            size="toolbar"
            className="flex-1"
          >
            <ArrowDownToLine className="h-3 w-3" />
            Update
          </Button>
        ) : (
          <div className="flex-1 flex items-center justify-center gap-1.5 h-7 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating…
          </div>
        )}
        <Button
          onClick={navigateToChangelog}
          variant="muted"
          size="toolbar"
        >
          Details
        </Button>
      </div>
    </div>
  );
}

function UserProfileSection({ user }: { user: { name: string; email: string; avatar: string; isAdmin?: boolean } }) {
  return <UserMenu user={user} />;
}

// ============================================================================
// Sessions + Legacy Threads + Projects Accordion
// ============================================================================

function SidebarSections() {
  const [legacyOpen, setLegacyOpen] = React.useState(false);
  const { data: legacyData, isLoading: legacyLoading } = useLegacyThreads();
  const pathname = normalizeAppPathname(usePathname());
  const { isMobile, setOpenMobile } = useSidebar();

  // Projects data — Kortix projects are the source of truth
  const { data: projectsData } = useKortixProjects();
  const sortedProjects = React.useMemo(() => {
    if (!projectsData || !Array.isArray(projectsData)) return [];
    return [...projectsData].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [projectsData]);

  const handleProjectClick = React.useCallback((project: KortixProject) => {
    openTabAndNavigate({
      id: `project:${project.id}`,
      title: project.name,
      type: 'project',
      href: `/projects/${encodeURIComponent(project.id)}`,
    });
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // Legacy threads
  const migrateAll = useMigrateAllLegacyThreads();
  const [migrateAllStarted, setMigrateAllStarted] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { data: migrateStatus } = useMigrateAllStatus(migrateAllStarted);

  const hasLegacy = !legacyLoading && legacyData && legacyData.threads.length > 0;
  const isMigrating = migrateStatus?.status === 'running';
  const migrateDone = migrateStatus?.status === 'done';

  const handleMigrateAll = React.useCallback(async () => {
    const server = useServerStore.getState();
    const active = server.servers.find((s) => s.id === server.activeServerId);
    if (!active?.sandboxId) return;

    setMigrateAllStarted(true);
    try {
      await migrateAll.mutateAsync({ sandboxExternalId: active.sandboxId });
    } catch {}
  }, [migrateAll]);

  const handleLegacyClick = (threadId: string, name: string) => {
    openTabAndNavigate({
      id: `legacy:${threadId}`,
      title: name || 'Previous Chat',
      type: 'page',
      href: `/legacy/${threadId}`,
    });
    if (isMobile) setOpenMobile(false);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1 pt-0.5 space-y-0.5">
      {/* Projects — collapsible list above Sessions, same UX as Sessions */}
      {sortedProjects.length > 0 && (
        <Collapsible defaultOpen={false} className="group/projects flex flex-col min-h-0">
          <div className="px-3 flex-shrink-0">
            <CollapsibleTrigger asChild>
              <Button variant="sidebar" className="rounded-lg">
                <FolderKanban className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                <span className="flex-1 text-left">Projects</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/projects:-rotate-90" />
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="min-h-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute left-[31.5px] top-1 bottom-1 w-px bg-sidebar-foreground/20"
              />
              <div className="flex flex-col pl-8">
                <div className="px-2 pb-2">
                  <div className="space-y-0.5">
                    {sortedProjects.map((project) => (
                      <div
                        key={project.id}
                        onClick={() => handleProjectClick(project)}
                        className={cn(
                          'flex items-center gap-2 py-1.5 pl-3.5 pr-2.5 rounded-lg text-[13px] cursor-pointer',
                          'transition-colors duration-150',
                          'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        )}
                      >
                        <span className="flex-1 truncate">{project.name}</span>
                        {(project.sessionCount ?? 0) > 0 && (
                          <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                            {project.sessionCount}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Sessions — always visible, takes remaining space */}
      <Collapsible defaultOpen className="group/sessions flex flex-col min-h-0 data-[state=open]:flex-1">
        <div className="px-3 flex-shrink-0">
          <CollapsibleTrigger asChild>
            <Button variant="sidebar" className="rounded-lg">
              <ListTree className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
              <span className="flex-1 text-left">Sessions</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/sessions:-rotate-90" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="min-h-0 data-[state=open]:flex-1 data-[state=open]:overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute left-[31.5px] top-1 bottom-1 w-px bg-sidebar-foreground/20"
            />
            <SessionList projectId={null} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {hasLegacy && (
        <div className="flex-shrink-0">
          <div className="px-3 flex items-center">
            <button
              onClick={() => setLegacyOpen((o) => !o)}
              className="flex items-center gap-3 flex-1 px-3 py-2 rounded-lg text-[13px] text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-150 cursor-pointer"
            >
              <History className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1 text-left">Previous Chats</span>
              <span className="text-[10px] tabular-nums text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                {legacyData!.total}
              </span>
              <ChevronDown className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                !legacyOpen && '-rotate-90',
              )} />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmOpen(true); }}
                  disabled={isMigrating || migrateDone || migrateAll.isPending}
                  className={cn(
                    'flex items-center justify-center h-7 w-7 rounded-lg flex-shrink-0 transition-colors duration-150',
                    migrateDone
                      ? 'text-emerald-500'
                      : isMigrating || migrateAll.isPending
                        ? 'text-muted-foreground cursor-not-allowed'
                        : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent cursor-pointer',
                  )}
                >
                  {migrateDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : isMigrating || migrateAll.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {migrateDone
                  ? `All converted${migrateStatus && migrateStatus.failed > 0 ? ` (${migrateStatus.failed} failed)` : ''}`
                  : isMigrating
                    ? `Converting ${migrateStatus?.completed ?? 0}/${migrateStatus?.total ?? 0}...`
                    : 'Convert all to sessions'}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* Progress bar — always visible when migrating */}
          {(isMigrating || migrateAll.isPending) && migrateStatus && migrateStatus.total > 0 && (
            <div className="px-6 pb-1.5">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-muted-foreground">
                  Converting {migrateStatus.completed}/{migrateStatus.total}
                  {migrateStatus.failed > 0 && <span className="text-destructive"> · {migrateStatus.failed} failed</span>}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-colors duration-300 ease-out"
                  style={{ width: `${Math.round(((migrateStatus.completed + migrateStatus.failed) / migrateStatus.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {migrateDone && migrateStatus && (
            <div className="px-6 pb-1.5">
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                Converted {migrateStatus.completed} chats
                {migrateStatus.failed > 0 && <span className="text-destructive"> · {migrateStatus.failed} failed</span>}
              </span>
            </div>
          )}
          {legacyOpen && (
            <div className="max-h-[40vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <div className="px-4 pb-2">
                <div className="space-y-0.5">
                  {legacyData!.threads.map((thread) => {
                    const isActive = pathname?.includes(thread.thread_id);
                    return (
                      <button
                        key={thread.thread_id}
                        onClick={() => handleLegacyClick(thread.thread_id, thread.name)}
                        className={cn(
                          'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[13px] cursor-pointer',
                          'transition-colors duration-150',
                          isActive
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        )}
                      >
                        <span className="flex-1 truncate text-left">{thread.name || 'Untitled'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Convert all previous chats?</AlertDialogTitle>
            <AlertDialogDescription>
              This will convert {legacyData?.total ?? 0} previous chats into sessions. The process runs in the background, but may take a few minutes depending on the number of chats.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleMigrateAll}>Convert all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================================
// Main Sidebar
// ============================================================================

function ScheduledDeletionCard() {
  const { sandbox, refetch } = useSandbox();
  const [reactivating, setReactivating] = useState(false);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const queryClient = useQueryClient();

  const activeServer = servers.find((s) => s.id === activeServerId);
  const activeInstanceId = activeServer?.instanceId;

  const { data: sandboxList, refetch: refetchList } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    staleTime: 30_000,
  });

  const activeSandbox = activeInstanceId && sandboxList
    ? sandboxList.find((s) => s.sandbox_id === activeInstanceId)
    : sandbox;

  if (!activeSandbox?.cancel_at_period_end) return null;

  const cancelAt = activeSandbox.cancel_at ? new Date(activeSandbox.cancel_at) : null;
  const dateStr = cancelAt
    ? cancelAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'billing period end';

  const sandboxIdToReactivate = activeSandbox.sandbox_id;

  const handleReactivate = async () => {
    setReactivating(true);
    try {
      await reactivateSandbox(sandboxIdToReactivate);
      toast.success('Instance reactivated');
      // Invalidate all sandbox-related caches so the card disappears
      await Promise.all([
        refetch(),
        refetchList(),
        queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] }),
        queryClient.invalidateQueries({ queryKey: ['accountState'] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reactivate');
    } finally {
      setReactivating(false);
    }
  };

  const daysLeft = cancelAt ? Math.max(0, Math.ceil((cancelAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-3">
      <p className="text-xs font-medium text-red-600 dark:text-red-400">
        Subscription cancelled
      </p>
      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
        This instance will be deleted {daysLeft !== null ? `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : `on ${dateStr}`}. All data will be permanently removed.
      </p>
      <Button
        type="button"
        disabled={reactivating}
        onClick={handleReactivate}
        variant="outline"
        size="toolbar"
        className="mt-2.5 w-full"
      >
        {reactivating ? <><Loader2 className="h-3 w-3 animate-spin" /> Reactivating...</> : 'Reactivate'}
      </Button>
    </div>
  );
}

function SidebarConfigDegradationNotice({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }) {
  const { sandbox } = useSandbox();
  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === activeServerId);
  const activeInstanceId = activeServer?.instanceId;

  const { data: sandboxList } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    staleTime: 30_000,
  });

  const activeSandbox = React.useMemo(() => {
    if (activeInstanceId && sandboxList) {
      return sandboxList.find((entry) => entry.sandbox_id === activeInstanceId) ?? sandbox ?? null;
    }
    return sandbox ?? null;
  }, [activeInstanceId, sandboxList, sandbox]);

  const sandboxUrl = React.useMemo(() => {
    if (!activeSandbox) return null;
    try {
      return getSandboxUrl(activeSandbox);
    } catch {
      return null;
    }
  }, [activeSandbox]);

  const configStatusQuery = useQuery<SidebarSandboxConfigStatus>({
    queryKey: ['sidebar', 'sandbox-config-status', activeSandbox?.sandbox_id, sandboxUrl],
    enabled: !!sandboxUrl,
    queryFn: async () => {
      const data = await sidebarSandboxRequestJson<unknown>(sandboxUrl!, '/config/status');
      if (!isSidebarSandboxConfigStatus(data)) {
        throw new Error('This runtime does not expose config diagnostics yet.');
      }
      return data;
    },
    staleTime: 5_000,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: true,
  });

  const projectsQuery = useQuery<SidebarProjectSummary[]>({
    queryKey: ['sidebar', 'sandbox-config-projects', activeSandbox?.sandbox_id, sandboxUrl],
    enabled: !!sandboxUrl && !!configStatusQuery.data && !configStatusQuery.data.valid,
    queryFn: async () => {
      const data = await sidebarSandboxRequestJson<unknown>(sandboxUrl!, '/kortix/projects');
      return Array.isArray(data) ? data as SidebarProjectSummary[] : [];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const configStatus = configStatusQuery.data;
  const hasProblem = !!configStatus && !configStatus.valid && configStatus.problems.length > 0;
  const configFixPrompt = React.useMemo(() => {
    if (!activeSandbox || !configStatus || configStatus.valid) return null;
    return buildSidebarConfigFixPrompt(activeSandbox, configStatus);
  }, [activeSandbox, configStatus]);
  const configFixProject = React.useMemo(
    () => pickSidebarConfigFixProject(projectsQuery.data ?? []),
    [projectsQuery.data],
  );

  const startTaskMutation = useMutation({
    mutationFn: async () => {
      if (!activeSandbox || !sandboxUrl || !configStatus || configStatus.valid) {
        throw new Error('No invalid config source is currently being skipped.');
      }
      const targetProject = configFixProject ?? await sidebarSandboxRequestJson<SidebarProjectSummary>(sandboxUrl, '/kortix/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Workspace',
          path: '/workspace',
          description: 'Default workspace project for runtime repair tasks.',
        }),
      });

      const task = await sidebarSandboxRequestJson<{ id: string }>(sandboxUrl, '/kortix/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: targetProject.id,
          title: configStatus.problems.length > 1 ? 'Fix ignored OpenCode config sources' : 'Fix ignored OpenCode config source',
          description: buildSidebarConfigFixPrompt(activeSandbox, configStatus),
          verification_condition: 'GET /config/status returns {"valid":true,"skippedSources":[]} for this instance.',
          status: 'todo',
        }),
      });

      await sidebarSandboxRequestJson(sandboxUrl, `/kortix/tasks/${encodeURIComponent(task.id)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      return { taskId: task.id, project: targetProject };
    },
    onSuccess: ({ taskId, project }) => {
      toast.success('Fix task started', {
        description: `Task ${taskId} is running in ${project.name || project.path}.`,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to start fix task');
    },
  });

  const handleCopyPrompt = React.useCallback(async () => {
    if (!configFixPrompt) return;
    try {
      await navigator.clipboard.writeText(configFixPrompt);
      toast.success('Fix prompt copied', {
        description: 'Paste it into a chat or task to repair the skipped config source.',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy fix prompt');
    }
  }, [configFixPrompt]);

  if (!hasProblem) return null;

  const primaryProblem = configStatus.problems[0];
  const taskTargetLabel = configFixProject ? `${configFixProject.name || configFixProject.path} (${configFixProject.path})` : null;

  if (collapsed) {
    return (
      <div className="w-full px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpand}
              className="relative flex items-center justify-center w-full py-2 rounded-lg cursor-pointer text-amber-400/90 hover:bg-amber-500/10 transition-colors duration-150"
            >
              <ShieldAlert className="h-4 w-4" />
              <span className="absolute top-1.5 right-2 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12} className="max-w-64 text-xs">
            <div className="font-medium">Config degraded — runtime still healthy</div>
            <div className="mt-1 text-muted-foreground">{primaryProblem.message || 'Invalid config source ignored.'}</div>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-500/18 bg-sidebar-accent/45 px-3 py-2.5 shadow-[0_1px_0_rgba(255,255,255,0.02)]">
      <div className="flex items-start gap-2.5">
        <div className="relative mt-0.5 shrink-0 text-amber-400/90">
          <ShieldAlert className="h-4 w-4" />
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/80 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-medium text-foreground">Config ignored</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/18 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              <CheckCircle2 className="h-2.5 w-2.5" />
              Runtime healthy
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              {primaryProblem.message || 'An invalid config source is being ignored.'}
            </div>
            <div className="truncate text-[10px] font-mono text-muted-foreground/80">
              {primaryProblem.source}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              type="button"
              size="toolbar"
              className="h-7 rounded-lg bg-foreground text-background hover:bg-foreground/90"
              onClick={() => startTaskMutation.mutate()}
              disabled={startTaskMutation.isPending}
            >
              {startTaskMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <SquarePen className="h-3 w-3" />}
              Fix
            </Button>
            <Button type="button" size="toolbar" variant="outline" className="h-7 rounded-lg border-border/60 bg-background/40" onClick={handleCopyPrompt}>
              <Copy className="h-3 w-3" />
              Prompt
            </Button>
            {configStatus.problems.length > 1 ? (
              <span className="text-[10px] text-muted-foreground">+{configStatus.problems.length - 1} more source{configStatus.problems.length === 2 ? '' : 's'}</span>
            ) : null}
          </div>

          <div className="text-[10px] text-muted-foreground/70 leading-relaxed">
            {taskTargetLabel
              ? `Fix task target: ${taskTargetLabel}`
              : 'Fix tasks will create a Workspace project automatically if needed.'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SidebarLeft({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  // On mobile, the sidebar always shows expanded content inside the Sheet
  const effectiveState = isMobile ? 'expanded' : state;
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = normalizeAppPathname(rawPathname);
  const currentInstanceId = getCurrentInstanceIdFromPathname(rawPathname) || getActiveInstanceIdFromCookie();
  const searchParams = useSearchParams();

  // Project filtering for session list removed — projects page merged into workspace

  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();

  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  const [user, setUser] = useState<{
    name: string;
    email: string;
    avatar: string;
    isAdmin?: boolean;
  }>({ name: 'Loading...', email: '', avatar: '', isAdmin: false });
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const fetchUserData = async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        setUser({
          name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
          email: data.user.email || '',
          avatar: data.user.user_metadata?.avatar_url || data.user.user_metadata?.picture || '',
          isAdmin,
        });
      }
    };
    fetchUserData();
  }, [isAdmin]);

  useEffect(() => {
    setIsMac(/Mac/.test(navigator.userAgent));
  }, []);

  const createSession = useCreateOpenCodeSession();

  const handleNewSession = useCallback(async () => {
    posthog.capture('new_task_clicked', { source: 'new_session_button' });
    try {
      const session = await createSession.mutateAsync();
      openTabAndNavigate({
        id: session.id,
        title: 'New session',
        type: 'session',
        href: `/sessions/${session.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
      // Focus the textarea in the newly visible session tab
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('focus-session-textarea'));
      });
      if (isMobile) setOpenMobile(false);
    } catch {
      router.push(currentInstanceId ? buildInstancePath(currentInstanceId, '/dashboard') : '/dashboard');
      if (isMobile) setOpenMobile(false);
    }
  }, [createSession, router, isMobile, setOpenMobile, currentInstanceId]);

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, searchParams, isMobile, setOpenMobile]);

  // Listen for right sidebar expansion → collapse left
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.expanded && state === 'expanded') {
        setOpen(false);
      }
    };
    window.addEventListener('sidebar-right-toggled', handler);
    return () => window.removeEventListener('sidebar-right-toggled', handler);
  }, [state, setOpen]);

  // Cmd+B is handled by the SidebarProvider in sidebar.tsx — do NOT duplicate
  // it here. Having two handlers on the same keypress caused a race condition:
  // the provider's toggleSidebar() would close the sidebar, then this handler
  // (reading stale `state`) would reopen it on the same tick.

  // Dispatch sidebar-left-toggled event when the sidebar state changes so the
  // right sidebar can auto-collapse (mutual exclusion).
  const prevStateRef = useRef(state);
  useEffect(() => {
    if (prevStateRef.current !== state) {
      prevStateRef.current = state;
      window.dispatchEvent(
        new CustomEvent('sidebar-left-toggled', {
          detail: { expanded: state === 'expanded' },
        }),
      );
    }
  }, [state]);

  // Cmd+J shortcut for new session (works globally, even when typing)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === 'j') {
        event.preventDefault();
        handleNewSession();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDocumentModalOpen, handleNewSession]);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
      {...props}
    >
      {/* ====== HEADER: Logo + collapse/expand ====== */}
      <SidebarHeader className="pt-3 pb-0 overflow-visible">
        <div className="relative flex h-[32px] items-center px-3 justify-between">
          {/* Collapsed: Kortix symbol (always visible), chevron on hover */}
          {effectiveState === 'collapsed' && (
            <div
              className="group/collapsed absolute inset-0 flex items-center justify-center cursor-pointer"
              onClick={() => {
                setOpen(true);
                window.dispatchEvent(new CustomEvent('sidebar-left-toggled', { detail: { expanded: true } }));
              }}
            >
              {/* Symbol — hides on hover */}
              <Link href="/dashboard" onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openTabAndNavigate({
                  id: 'page:/dashboard',
                  title: 'Dashboard',
                  type: 'dashboard',
                  href: '/dashboard',
                }, router);
                if (isMobile) setOpenMobile(false);
              }} className="flex items-center justify-center group-hover/collapsed:hidden">
                <KortixLogo
                  variant="symbol"
                  size={20}
                  className="flex-shrink-0"
                />
              </Link>
              <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground hidden group-hover/collapsed:block" />
            </div>
          )}
          <div className={cn(
            'flex items-center transition-opacity duration-200',
            effectiveState === 'collapsed' && 'opacity-0 pointer-events-none'
          )}>
            <Link href="/dashboard" onClick={(e) => {
              e.preventDefault();
              openTabAndNavigate({
                id: 'page:/dashboard',
                title: 'Dashboard',
                type: 'dashboard',
                href: '/dashboard',
              }, router);
              if (isMobile) setOpenMobile(false);
            }} className="flex items-center">
              <KortixLogo
                variant="logomark"
                size={16}
                className="flex-shrink-0"
              />
            </Link>
          </div>

          <button
            className={cn(
              'flex items-center justify-center h-7 w-7 rounded-lg transition-colors duration-150 cursor-pointer',
        'text-sidebar-foreground hover:bg-sidebar-accent',
              effectiveState === 'collapsed' ? 'opacity-0 pointer-events-none' : 'opacity-100'
            )}
            onClick={() => isMobile ? setOpenMobile(false) : setOpen(false)}
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      </SidebarHeader>

      {/* ====== CONTENT ====== */}
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] relative overflow-visible">
        {/* --- Collapsed: icon buttons --- */}
        <div className={cn(
          'absolute inset-0 px-2 pt-2 space-y-0.5 flex flex-col items-center',
          effectiveState === 'collapsed' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}>
          <CollapsedIconButton
            icon={<SquarePen className="h-4 w-4" />}
            label="New session"
            onClick={handleNewSession}
            disabled={createSession.isPending}
          />
          <CollapsedIconButton
            icon={<Search className="h-4 w-4" />}
            label="Search"
            onClick={() => {
              document.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: 'k',
                  code: 'KeyK',
                  metaKey: isMac,
                  ctrlKey: !isMac,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }}
          />
          <CollapsedIconButton
            icon={<FolderOpen className="h-4 w-4" />}
            label="Files"
            isActive={pathname === '/files'}
            onClick={() => {
              openTabAndNavigate({
                id: 'page:/files',
                title: 'Files',
                type: 'page',
                href: '/files',
              });
            }}
          />
          <CollapsedIconButton
            icon={<FolderKanban className="h-4 w-4" />}
            label="Projects"
            flyoutContent={<ProjectsFlyout />}
          />
          <CollapsedIconButton
            icon={<ListTree className="h-4 w-4" />}
            label="Sessions"
            flyoutContent={<SessionsFlyout collapsed />}
          />
        </div>

        {/* --- Expanded layout --- */}
        <div className={cn(
          'flex flex-col h-full min-h-0',
          effectiveState === 'collapsed' ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
        )}>
          {/* Navigation */}
          <nav className="flex-shrink-0 px-3 pt-2 space-y-0.5">
            {/* New session */}
            <Button
              onClick={handleNewSession}
              disabled={createSession.isPending}
              variant="sidebar"
              className="rounded-lg"
            >
              <SquarePen className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
              <span className="flex-1 text-left">{createSession.isPending ? 'Creating...' : 'New session'}</span>
              <kbd className="text-[10px] text-muted-foreground">
                {isMac ? '\u2318J' : 'Ctrl J'}
              </kbd>
            </Button>

            {/* Search */}
            <Button
              onClick={() => {
                document.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: 'k',
                    code: 'KeyK',
                    metaKey: isMac,
                    ctrlKey: !isMac,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
              }}
              variant="sidebar"
              className="rounded-lg"
            >
              <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
              <span className="flex-1 text-left">Search</span>
              <kbd className="text-[10px] text-muted-foreground">
                {isMac ? '\u2318K' : 'Ctrl K'}
              </kbd>
            </Button>

            {/* Files */}
            <Button
              onClick={() => {
                openTabAndNavigate({
                  id: 'page:/files',
                  title: 'Files',
                  type: 'page',
                  href: '/files',
                });
              }}
              variant="sidebar"
              className="rounded-lg"
            >
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
              <span className="flex-1 text-left">Files</span>
            </Button>

            {/* Sessions — expandable, default open */}
            </nav>

          <SidebarSections />
        </div>
      </SidebarContent>

      {/* ====== FOOTER ====== */}
      <SidebarFooter className="px-3 pb-3 pt-0 group-data-[collapsible=icon]:px-0 gap-2">
        <SidebarConfigDegradationNotice
          collapsed={effectiveState === 'collapsed'}
          onExpand={() => {
            setOpen(true);
            window.dispatchEvent(new CustomEvent('sidebar-left-toggled', { detail: { expanded: true } }));
          }}
        />
        <ScheduledDeletionCard />
        <SidebarUpdateIndicator collapsed={effectiveState === 'collapsed'} />
        <UserProfileSection user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
