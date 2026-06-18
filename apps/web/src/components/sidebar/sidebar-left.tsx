'use client';

import { useTranslations } from 'next-intl';

import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRightLeft,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  History,
  ListTree,
  Loader2,
  Search,
  ShieldAlert,
  Sparkles,
  SquarePen,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { SessionList } from '@/components/sidebar/session-list';
import {
  useLegacyThreads,
  useMigrateAllLegacyThreads,
  useMigrateAllStatus,
} from '@/hooks/legacy/use-legacy-threads';
import { useGlobalSandboxUpdate } from '@/hooks/platform/use-global-sandbox-update';
import { useUpdateDialogStore } from '@/stores/update-dialog-store';

import {
  CurrentWorkspaceAvatar,
  InstanceSwitcherPopover,
  WorkspacesFlyoutContent,
} from '@/components/sidebar/instance-switcher-popover';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ThreadIcon } from '@/components/sidebar/thread-icon';
import { UserMenu } from '@/features/layout/user-menu';

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
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAdminRole } from '@/hooks/admin';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';

import {
  useCreateOpenCodeSession,
  useOpenCodeSessions,
} from '@/hooks/opencode/use-opencode-sessions';
import { useSandbox } from '@/hooks/platform/use-sandbox';
import { authenticatedFetch } from '@/lib/auth-token';
import {
  buildInstancePath,
  getActiveInstanceIdFromCookie,
  getCurrentInstanceIdFromPathname,
  normalizeAppPathname,
} from '@/lib/instance-routes';
import {
  getSandboxUrl,
  listSandboxes,
  reactivateSandbox,
  type SandboxInfo,
} from '@/lib/platform-client';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/lib/toast';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
  return (
    typeof candidate.valid === 'boolean' &&
    Array.isArray(candidate.loadedSources) &&
    Array.isArray(candidate.skippedSources) &&
    Array.isArray(candidate.problems)
  );
}

async function sidebarSandboxRequestJson<T>(
  sandboxUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await authenticatedFetch(
    `${sandboxUrl.replace(/\/+$/, '')}${path}`,
    {
      signal: AbortSignal.timeout(10_000),
      ...init,
    },
    { retryOnAuthError: false },
  );

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
    const message =
      typeof data === 'object' && data && 'error' in data
        ? String((data as Record<string, unknown>).error)
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function pickSidebarConfigFixProject(
  projects: SidebarProjectSummary[],
): SidebarProjectSummary | null {
  return projects.find((project) => project.path === '/workspace') ?? projects[0] ?? null;
}

function buildSidebarConfigFixPrompt(
  sandbox: SandboxInfo,
  status: SidebarSandboxConfigStatus,
): string {
  const header = `Inspect and repair the ignored OpenCode config sources for instance "${sandbox.name || sandbox.sandbox_id}".`;
  const explanation =
    'OpenCode is running in fail-soft mode and skipped the invalid sources below instead of crashing the runtime.';
  const problems = status.problems
    .map((problem, index) => {
      const issueLines = (problem.issues ?? []).map((issue) => issue.message).filter(Boolean);
      return [
        `${index + 1}. Source: ${problem.source}`,
        `   Scope: ${problem.scope}`,
        `   Kind: ${problem.kind}`,
        `   Message: ${problem.message || 'No message provided.'}`,
        ...(issueLines.length ? issueLines.map((line) => `   Detail: ${line}`) : []),
      ].join('\n');
    })
    .join('\n\n');

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

// Two-chip keybind hint shown on the right of sidebar nav rows. Each
// key gets its own rounded chip with a subtle bg, like macOS's native
// shortcut display. Visible only when the parent `group/row` is hovered
// so the sidebar reads clean by default.
function KbdHint({ mod, letter }: { mod: string; letter: string }) {
  const chip =
    'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded bg-foreground/[0.05] border border-border/40 text-xs font-medium text-muted-foreground/70 leading-none font-sans select-none';
  return (
    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
      <kbd className={chip}>{mod}</kbd>
      <kbd className={chip}>{letter}</kbd>
    </span>
  );
}

function CollapsedIconButton({
  icon,
  label,
  onClick,
  flyoutContent,
  disabled,
  isActive,
}: CollapsedIconButtonProps) {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlyoutOpen(false), 180);
  }, []);

  const cancelClose = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyoutOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flyoutOpen]);

  // Close on click outside
  useEffect(() => {
    if (!flyoutOpen) return;
    const onDown = (e: PointerEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        flyoutRef.current?.contains(e.target as Node)
      )
        return;
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
          onMouseEnter={() => {
            cancelClose();
            setFlyoutOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          {icon}
        </button>
        {flyoutOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={flyoutRef}
              style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 10001 }}
              className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-[0.98] slide-in-from-left-1 flex max-h-[60vh] w-[260px] flex-col overflow-hidden rounded-2xl border shadow-lg duration-100"
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
        <button ref={btnRef} onClick={onClick} disabled={disabled} className={btnClass}>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    return (
      Object.values(permissions).filter((p) => p.sessionID === id).length +
      Object.values(questions).filter((q) => q.sessionID === id).length
    );
  };

  return (
    <div className="[scrollbar-width:none] overflow-y-auto py-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      {rootSessions.length === 0 ? (
        <div className="text-muted-foreground px-3 py-8 text-center text-xs">
          {tHardcodedUi.raw('componentsSidebarSidebarLeft.line340JsxTextNoSessionsYet')}
        </div>
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
                'flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-xs transition-colors duration-100',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              {!collapsed && (
                <ThreadIcon iconName={(session as any).icon} className="flex-shrink-0" size={12} />
              )}
              <span className="flex-1 truncate text-left">{session.title || 'Untitled'}</span>
              {pending > 0 && (
                <span className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/15 px-1 text-xs font-semibold text-amber-500">
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const {
    updateAvailable,
    latestVersion,
    currentChannel,
    changelog,
    isUpdating,
    updateResult,
    isBackingUp,
    isDestructive,
    phaseProgress,
    hasActiveUpdate,
    phase,
    phaseMessage,
    updateErrorMessage,
    canCancel,
    isCancelling,
    cancel,
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
    try {
      localStorage.setItem(dismissKey, 'true');
    } catch {}
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
  if (
    !mounted ||
    (!updateAvailable && !hasActiveUpdate) ||
    (dismissed && !hasActiveUpdate) ||
    updateResult?.success
  )
    return null;

  // ── Collapsed state: icon with pulse dot ──
  if (collapsed) {
    return (
      <div className="flex justify-center">
        <button
          onClick={hasActiveUpdate ? undefined : navigateToChangelog}
          className="hover:bg-primary/10 relative cursor-pointer rounded-lg p-2 transition-colors"
          title={
            hasActiveUpdate
              ? `${phaseMessage || phase} (${phaseProgress}%)`
              : `v${latestVersion} available`
          }
        >
          {hasActiveUpdate ? (
            <Loader2 className="text-primary h-4 w-4 animate-spin" />
          ) : (
            <ArrowDownToLine className="text-primary h-4 w-4" />
          )}
          <span className="bg-primary absolute top-1 right-1 h-2 w-2 animate-pulse rounded-full" />
        </button>
      </div>
    );
  }

  if (showBackupCard) {
    return (
      <div className="border-primary/15 bg-muted/40 overflow-hidden rounded-2xl border">
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Loader2 className="text-primary h-3.5 w-3.5 flex-shrink-0 animate-spin" />
          <span className="text-foreground min-w-0 truncate text-xs font-semibold">
            {tHardcodedUi.raw('componentsSidebarSidebarLeft.line461JsxTextBackingUpSandbox')}
          </span>
          <span className="flex-1" />
          <span className="text-muted-foreground flex-shrink-0 text-xs">v{latestVersion}</span>
        </div>
        <p className="text-muted-foreground px-3 pb-2 text-xs leading-tight">
          {phaseMessage ||
            'You can keep using your machine. Update will continue automatically once the backup completes.'}
        </p>
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <div className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-all"
              style={{ width: `${phaseProgress}%` }}
            />
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
      <div className="overflow-hidden rounded-2xl border border-red-500/20 bg-red-500/[0.04]">
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <Bug className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />
          <span className="text-foreground min-w-0 truncate text-xs font-semibold">
            {tHardcodedUi.raw('componentsSidebarSidebarLeft.line488JsxTextUpdateFailed')}
          </span>
          <span className="flex-1" />
          <span className="text-muted-foreground flex-shrink-0 text-xs">v{latestVersion}</span>
        </div>
        <p className="text-muted-foreground line-clamp-3 px-3 pb-2 text-xs leading-tight">
          {updateErrorMessage || phaseMessage || 'Something went wrong during the update.'}
        </p>
        <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
          <Button onClick={() => openDialog()} variant="default" size="toolbar" className="flex-1">
            Retry
          </Button>
          <Button onClick={navigateToChangelog} variant="muted" size="toolbar">
            Details
          </Button>
        </div>
      </div>
    );
  }

  if (isDestructive) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2.5">
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-amber-700 dark:text-amber-300">
            {phaseMessage || `Installing v${latestVersion}…`}
          </span>
          <span className="block truncate text-xs text-amber-700/70 dark:text-amber-300/70">
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
    <div className="border-primary/15 bg-primary/[0.03] overflow-hidden rounded-2xl border">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="bg-primary/60 absolute inline-flex h-full w-full animate-ping rounded-full" />
          <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
        </span>
        <span className="text-foreground min-w-0 truncate text-xs font-semibold">
          {currentChannel === 'dev' ? 'New dev build' : 'New Kortix version'}
        </span>
        <span className="flex-1" />
        <span className="text-muted-foreground flex-shrink-0 text-xs">v{latestVersion}</span>
        <button
          onClick={handleDismiss}
          className="hover:bg-muted/80 flex-shrink-0 cursor-pointer rounded p-0.5 transition-colors"
          aria-label="Dismiss"
        >
          <X className="text-muted-foreground/60 h-3 w-3" />
        </button>
      </div>

      {/* Change list */}
      {previewChanges.length > 0 && (
        <div className="space-y-0.5 px-3 pb-1.5">
          {previewChanges.map((change, i) => {
            const Icon = changeTypeIcon[change.type] ?? Zap;
            const color = changeTypeColor[change.type] ?? 'text-muted-foreground';
            return (
              <div key={i} className="flex items-start gap-1.5">
                <Icon className={cn('mt-[1px] h-3 w-3 flex-shrink-0', color)} />
                <span className="text-muted-foreground line-clamp-1 text-xs leading-tight">
                  {change.text}
                </span>
              </div>
            );
          })}
          {remaining > 0 && (
            <button
              onClick={navigateToChangelog}
              className="text-primary/70 hover:text-primary cursor-pointer pl-[18px] text-xs font-medium transition-colors"
            >
              +{remaining} more
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
        {!hasActiveUpdate ? (
          <Button onClick={() => openDialog()} variant="default" size="toolbar" className="flex-1">
            <ArrowDownToLine className="h-3 w-3" />
            Update
          </Button>
        ) : (
          <div className="flex h-7 flex-1 items-center justify-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {tHardcodedUi.raw('componentsSidebarSidebarLeft.line587JsxTextUpdating')}
          </div>
        )}
        <Button onClick={navigateToChangelog} variant="muted" size="toolbar">
          Details
        </Button>
      </div>
    </div>
  );
}

function UserProfileSection({
  user,
}: {
  user: { name: string; email: string; avatar: string; isAdmin?: boolean };
}) {
  return <UserMenu user={user} />;
}

// ============================================================================
// Sessions + Legacy Threads Accordion
// ============================================================================

function SidebarSections() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [legacyOpen, setLegacyOpen] = React.useState(false);
  const { data: legacyData, isLoading: legacyLoading } = useLegacyThreads();
  const pathname = normalizeAppPathname(usePathname());
  const { isMobile, setOpenMobile } = useSidebar();

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
    <div className="flex min-h-0 flex-1 flex-col space-y-0.5 pt-0.5">
      {/* Sessions — always visible, takes remaining space */}
      <Collapsible
        defaultOpen
        className="group/sessions flex min-h-0 flex-col data-[state=open]:flex-1"
      >
        <div className="flex-shrink-0 px-3">
          <CollapsibleTrigger asChild>
            <Button variant="sidebar" className="rounded-lg">
              <ListTree className="text-sidebar-foreground flex-shrink-0" />
              <span className="flex-1 text-left">Sessions</span>
              <ChevronDown className="text-muted-foreground size-3 transition-transform duration-200 group-data-[state=closed]/sessions:-rotate-90" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="min-h-0 [scrollbar-width:none] [-ms-overflow-style:none] data-[state=open]:flex-1 data-[state=open]:overflow-y-auto data-[state=open]:pt-1 [&::-webkit-scrollbar]:hidden">
          <SessionList projectId={null} />
        </CollapsibleContent>
      </Collapsible>

      {hasLegacy && (
        // mt-auto pins this block to the bottom of the SidebarSections column.
        // Sessions above is `data-[state=open]:flex-1` (eats remaining space
        // when expanded) so mt-auto becomes 0 in that state — Previous Chats
        // ends up directly under Sessions either way. When Sessions is
        // COLLAPSED, mt-auto kicks in and pushes Previous Chats to the very
        // bottom of the scroll area, just above the footer card stack.
        <div className="mt-auto flex-shrink-0">
          <div className="flex items-center px-3">
            <button
              onClick={() => setLegacyOpen((o) => !o)}
              className="text-sidebar-foreground hover:bg-sidebar-accent flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150"
            >
              <History className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="flex-1 text-left">
                {tHardcodedUi.raw('componentsSidebarSidebarLeft.line679JsxTextPreviousChats')}
              </span>
              <span className="text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 text-xs tabular-nums">
                {legacyData!.total}
              </span>
              <ChevronDown
                className={cn(
                  'text-muted-foreground size-3 transition-transform duration-200',
                  !legacyOpen && '-rotate-90',
                )}
              />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmOpen(true);
                  }}
                  disabled={isMigrating || migrateDone || migrateAll.isPending}
                  className={cn(
                    'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
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
              <div className="mb-1 flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  Converting {migrateStatus.completed}/{migrateStatus.total}
                  {migrateStatus.failed > 0 && (
                    <span className="text-destructive"> · {migrateStatus.failed} failed</span>
                  )}
                </span>
              </div>
              <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full rounded-full transition-colors duration-300 ease-out"
                  style={{
                    width: `${Math.round(((migrateStatus.completed + migrateStatus.failed) / migrateStatus.total) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {migrateDone && migrateStatus && (
            <div className="px-6 pb-1.5">
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                Converted {migrateStatus.completed} chats
                {migrateStatus.failed > 0 && (
                  <span className="text-destructive"> · {migrateStatus.failed} failed</span>
                )}
              </span>
            </div>
          )}
          {legacyOpen && (
            <div className="max-h-[40vh] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              <div className="px-4 pb-2">
                <div className="space-y-0.5">
                  {legacyData!.threads.map((thread) => {
                    const isActive = pathname?.includes(thread.thread_id);
                    return (
                      <button
                        key={thread.thread_id}
                        onClick={() => handleLegacyClick(thread.thread_id, thread.name)}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1 text-xs',
                          'transition-colors duration-150',
                          isActive
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        )}
                      >
                        <span className="flex-1 truncate text-left">
                          {thread.name || 'Untitled'}
                        </span>
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
            <AlertDialogTitle>
              {tHardcodedUi.raw(
                'componentsSidebarSidebarLeft.line777JsxTextConvertAllPreviousChats',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tHardcodedUi.raw('componentsSidebarSidebarLeft.line779JsxTextThisWillConvert')}{' '}
              {legacyData?.total ?? 0}
              {tHardcodedUi.raw(
                'componentsSidebarSidebarLeft.line779JsxTextPreviousChatsIntoSessionsTheProcessRunsIn',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleMigrateAll}>
              {tHardcodedUi.raw('componentsSidebarSidebarLeft.line784JsxTextConvertAll')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================================
// Main Sidebar
// ============================================================================

function ScheduledDeletionCard({
  collapsed,
  onExpand,
}: {
  collapsed: boolean;
  onExpand: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const activeSandbox =
    activeInstanceId && sandboxList
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

  const daysLeft = cancelAt
    ? Math.max(0, Math.ceil((cancelAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;
  const detail = `Deletion ${daysLeft !== null ? `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : `on ${dateStr}`}. All data will be removed.`;

  // Collapsed: same DNA as SidebarConfigDegradationNotice — small icon
  // button + pulsing dot + tooltip. Click expands the sidebar so the user
  // can see the full card and hit Reactivate.
  if (collapsed) {
    return (
      <div className="w-full px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpand}
              aria-label={tHardcodedUi.raw(
                'componentsSidebarSidebarLeft.line858JsxAttrAriaLabelSubscriptionCancelledClickToReactivate',
              )}
              className="text-destructive hover:bg-destructive/10 relative flex w-full cursor-pointer items-center justify-center rounded-lg py-2 transition-colors duration-150"
            >
              <AlertTriangle className="h-4 w-4" />
              <span className="absolute top-1.5 right-2 flex h-2 w-2">
                <span className="bg-destructive absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                <span className="bg-destructive relative inline-flex h-2 w-2 rounded-full" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12} className="max-w-64 text-xs">
            <div className="text-destructive font-medium">
              {tHardcodedUi.raw('componentsSidebarSidebarLeft.line869JsxTextSubscriptionCancelled')}
            </div>
            <div className="text-muted-foreground mt-1">{detail}</div>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <InfoBanner
      tone="destructive"
      title={tHardcodedUi.raw(
        'componentsSidebarSidebarLeft.line878JsxAttrTitleSubscriptionCancelled',
      )}
    >
      <p className="leading-relaxed">
        {tHardcodedUi.raw('componentsSidebarSidebarLeft.line880JsxTextThisInstanceWillBeDeleted')}{' '}
        {daysLeft !== null ? `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : `on ${dateStr}`}
        {tHardcodedUi.raw(
          'componentsSidebarSidebarLeft.line880JsxTextAllDataWillBePermanentlyRemoved',
        )}
      </p>
      <Button
        type="button"
        disabled={reactivating}
        onClick={handleReactivate}
        variant="outline"
        size="toolbar"
        className="mt-2.5 w-full"
      >
        {reactivating ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> Reactivating...
          </>
        ) : (
          'Reactivate'
        )}
      </Button>
    </InfoBanner>
  );
}

function SidebarConfigDegradationNotice({
  collapsed,
  onExpand,
}: {
  collapsed: boolean;
  onExpand: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      return Array.isArray(data) ? (data as SidebarProjectSummary[]) : [];
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
      const targetProject =
        configFixProject ??
        (await sidebarSandboxRequestJson<SidebarProjectSummary>(sandboxUrl, '/kortix/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Workspace',
            path: '/workspace',
            description: 'Default workspace project for runtime repair tasks.',
          }),
        }));

      const task = await sidebarSandboxRequestJson<{ id: string }>(sandboxUrl, '/kortix/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: targetProject.id,
          title:
            configStatus.problems.length > 1
              ? 'Fix ignored OpenCode config sources'
              : 'Fix ignored OpenCode config source',
          description: buildSidebarConfigFixPrompt(activeSandbox, configStatus),
          verification_condition:
            'GET /config/status returns {"valid":true,"skippedSources":[]} for this instance.',
          status: 'todo',
        }),
      });

      await sidebarSandboxRequestJson(
        sandboxUrl,
        `/kortix/tasks/${encodeURIComponent(task.id)}/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      );

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
  const taskTargetLabel = configFixProject
    ? `${configFixProject.name || configFixProject.path} (${configFixProject.path})`
    : null;

  if (collapsed) {
    return (
      <div className="w-full px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpand}
              className="relative flex w-full cursor-pointer items-center justify-center rounded-lg py-2 text-amber-400/90 transition-colors duration-150 hover:bg-amber-500/10"
            >
              <ShieldAlert className="h-4 w-4" />
              <span className="absolute top-1.5 right-2 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12} className="max-w-64 text-xs">
            <div className="font-medium">
              {tHardcodedUi.raw(
                'componentsSidebarSidebarLeft.line1042JsxTextConfigDegradedRuntimeStillHealthy',
              )}
            </div>
            <div className="text-muted-foreground mt-1">
              {primaryProblem.message || 'Invalid config source ignored.'}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="bg-sidebar-accent/45 rounded-2xl border border-amber-500/18 px-3 py-2.5 shadow-[0_1px_0_rgba(255,255,255,0.02)]">
      <div className="flex items-start gap-2.5">
        <div className="relative mt-0.5 shrink-0 text-amber-400/90">
          <ShieldAlert className="h-4 w-4" />
          <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/80 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-xs font-medium">
              {tHardcodedUi.raw('componentsSidebarSidebarLeft.line1063JsxTextConfigIgnored')}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/18 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="h-2.5 w-2.5" />
              {tHardcodedUi.raw('componentsSidebarSidebarLeft.line1066JsxTextRuntimeHealthy')}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-muted-foreground text-xs leading-relaxed">
              {primaryProblem.message || 'An invalid config source is being ignored.'}
            </div>
            <div className="text-muted-foreground/80 truncate font-mono text-xs">
              {primaryProblem.source}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="toolbar"
              className="bg-foreground text-background hover:bg-foreground/90 h-7 rounded-lg"
              onClick={() => startTaskMutation.mutate()}
              disabled={startTaskMutation.isPending}
            >
              {startTaskMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <SquarePen className="h-3 w-3" />
              )}
              Fix
            </Button>
            <Button
              type="button"
              size="toolbar"
              variant="outline"
              className="border-border/60 bg-background/40 h-7 rounded-lg"
              onClick={handleCopyPrompt}
            >
              <Copy className="h-3 w-3" />
              Prompt
            </Button>
            {configStatus.problems.length > 1 ? (
              <span className="text-muted-foreground text-xs">
                +{configStatus.problems.length - 1}
                {tHardcodedUi.raw('componentsSidebarSidebarLeft.line1095JsxTextMoreSource')}{' '}
                {configStatus.problems.length === 2 ? '' : 's'}
              </span>
            ) : null}
          </div>

          <div className="text-muted-foreground/70 text-xs leading-relaxed">
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  // On mobile, the sidebar always shows expanded content inside the Sheet
  const effectiveState = isMobile ? 'expanded' : state;
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = normalizeAppPathname(rawPathname);
  const currentInstanceId =
    getCurrentInstanceIdFromPathname(rawPathname) || getActiveInstanceIdFromCookie();
  const searchParams = useSearchParams();

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
      router.push(
        currentInstanceId ? buildInstancePath(currentInstanceId, '/dashboard') : '/dashboard',
      );
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

  // Cmd+J / Cmd+N shortcut for new session (works globally, even when typing).
  // Cmd+N is hijacked by the browser in the web build (opens a new window),
  // but reaches the webview in the Tauri desktop shell where it acts as the
  // standard "new chat" accelerator.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'j' || event.key === 'n' || event.key === 'N')
      ) {
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
      className="bg-sidebar [scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
      {...props}
    >
      {/* ====== HEADER: Logo + collapse/expand ====== */}
      <SidebarHeader className="overflow-visible pt-3 pb-0">
        <div className="relative flex h-[32px] items-center justify-between px-3">
          {/* Collapsed: Kortix symbol (always visible), chevron on hover */}
          {effectiveState === 'collapsed' && (
            <div
              className="group/collapsed absolute inset-0 flex cursor-pointer items-center justify-center"
              onClick={() => {
                setOpen(true);
                window.dispatchEvent(
                  new CustomEvent('sidebar-left-toggled', { detail: { expanded: true } }),
                );
              }}
            >
              {/* Symbol — hides on hover */}
              <Link
                href="/dashboard"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openTabAndNavigate(
                    {
                      id: 'page:/dashboard',
                      title: 'Dashboard',
                      type: 'dashboard',
                      href: '/dashboard',
                    },
                    router,
                  );
                  if (isMobile) setOpenMobile(false);
                }}
                className="flex items-center justify-center group-hover/collapsed:hidden"
              >
                <KortixLogo variant="symbol" size={20} className="flex-shrink-0" />
              </Link>
              <ChevronRight className="text-sidebar-foreground hidden h-3.5 w-3.5 group-hover/collapsed:block" />
            </div>
          )}
          <div
            className={cn(
              'flex items-center transition-opacity duration-200',
              effectiveState === 'collapsed' && 'pointer-events-none opacity-0',
            )}
          >
            <Link
              href="/dashboard"
              onClick={(e) => {
                e.preventDefault();
                openTabAndNavigate(
                  {
                    id: 'page:/dashboard',
                    title: 'Dashboard',
                    type: 'dashboard',
                    href: '/dashboard',
                  },
                  router,
                );
                if (isMobile) setOpenMobile(false);
              }}
              className="flex items-center"
            >
              <KortixLogo variant="logomark" size={16} className="flex-shrink-0" />
            </Link>
          </div>

          <button
            className={cn(
              'flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150',
              'text-sidebar-foreground hover:bg-sidebar-accent',
              effectiveState === 'collapsed' ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
            onClick={() => (isMobile ? setOpenMobile(false) : setOpen(false))}
            aria-label={tHardcodedUi.raw(
              'componentsSidebarSidebarLeft.line1304JsxAttrAriaLabelCollapseSidebar',
            )}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Workspace-style instance switcher — single click to swap, no full-page nav. */}
        <div className={cn('px-2 pt-2', effectiveState === 'collapsed' && 'hidden')}>
          <InstanceSwitcherPopover />
        </div>
      </SidebarHeader>

      {/* ====== CONTENT ====== */}
      <SidebarContent className="relative [scrollbar-width:'none'] overflow-visible [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden">
        {/* --- Collapsed: icon buttons --- */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col items-center space-y-0.5 px-2 pt-2',
            effectiveState === 'collapsed'
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0',
          )}
        >
          {/* Workspace preview — current workspace avatar with hover flyout
              for switching instances. Sits at
              the top of the rail so users always see "this is the workspace
              I'm in" even when collapsed. */}
          <CollapsedIconButton
            icon={<CurrentWorkspaceAvatar />}
            label="Workspace"
            flyoutContent={<WorkspacesFlyoutContent />}
          />
          <CollapsedIconButton
            icon={<SquarePen className="h-4 w-4" />}
            label={tHardcodedUi.raw('componentsSidebarSidebarLeft.line1339JsxAttrLabelNewSession')}
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
            icon={<ListTree className="h-4 w-4" />}
            label="Sessions"
            flyoutContent={<SessionsFlyout collapsed />}
          />
        </div>

        {/* --- Expanded layout --- */}
        <div
          className={cn(
            'flex h-full min-h-0 flex-col',
            effectiveState === 'collapsed'
              ? 'pointer-events-none opacity-0'
              : 'pointer-events-auto opacity-100',
          )}
        >
          {/* Navigation */}
          <nav className="flex-shrink-0 space-y-0.5 px-3 pt-2">
            {/* New session */}
            <Button
              onClick={handleNewSession}
              disabled={createSession.isPending}
              variant="sidebar"
              className="group/row rounded-lg"
            >
              <SquarePen className="text-sidebar-foreground flex-shrink-0" />
              <span className="flex-1 text-left">
                {createSession.isPending ? 'Creating...' : 'New session'}
              </span>
              <KbdHint mod={isMac ? '\u2318' : 'Ctrl'} letter="J" />
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
              className="group/row rounded-lg"
            >
              <Search className="text-sidebar-foreground flex-shrink-0" />
              <span className="flex-1 text-left">Search</span>
              <KbdHint mod={isMac ? '\u2318' : 'Ctrl'} letter="K" />
            </Button>

            {/* Files lives exclusively on the right sidebar — no redundant
                entry here. Board is also right-sidebar-only (see
                menu-registry entry `board`). */}
          </nav>

          <SidebarSections />
        </div>
      </SidebarContent>

      {/* ====== FOOTER ====== */}
      <SidebarFooter className="gap-2 px-3 pt-0 pb-3 group-data-[collapsible=icon]:px-0">
        <SidebarConfigDegradationNotice
          collapsed={effectiveState === 'collapsed'}
          onExpand={() => {
            setOpen(true);
            window.dispatchEvent(
              new CustomEvent('sidebar-left-toggled', { detail: { expanded: true } }),
            );
          }}
        />
        <ScheduledDeletionCard
          collapsed={effectiveState === 'collapsed'}
          onExpand={() => {
            setOpen(true);
            window.dispatchEvent(
              new CustomEvent('sidebar-left-toggled', { detail: { expanded: true } }),
            );
          }}
        />
        <SidebarUpdateIndicator collapsed={effectiveState === 'collapsed'} />
        <UserProfileSection user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
