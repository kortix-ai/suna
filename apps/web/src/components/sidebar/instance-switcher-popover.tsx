'use client';

/**
 * Workspace switcher — Slack/Linear-style.
 *
 * The ONLY in-app workspace switcher (the user-menu list and the standalone
 * /instances list-page selector were removed for redundancy). Lives in the
 * sidebar header and reads as "this is the workspace you're in":
 *
 *   ┌───────────────────────────────────────┐
 *   │ ◼ Workspace Name              ⇅      │
 *   └───────────────────────────────────────┘
 *
 *   - Square workspace avatar (initials) — gives a visual identity per
 *     workspace, the way Slack does it
 *   - Bold workspace name — the active workspace
 *   - ChevronsUpDown affordance on the right — "click to switch"
 *
 * Click → CommandPopover with: search (5+ workspaces), instance rows with a
 * matching avatar + check mark on active, inline gear → settings modal,
 * "+ New workspace" (opens global NewInstanceModal), "All workspaces" → /instances picker.
 */

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Box,
  Check,
  ChevronsUpDown,
  Loader2,
  Plus,
  Settings2,
} from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { InstanceSettingsModal } from '@/app/instances/_components/instance-settings-modal';
import { isBillingEnabled } from '@/lib/config';
import { listSandboxes, ensureSandbox, type SandboxInfo } from '@/lib/platform-client';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { activateInstanceSelection, useServerStore } from '@/stores/server-store';
import { cn } from '@/lib/utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function displayName(s: SandboxInfo): string {
  if (s.name && s.name.trim()) return s.name;
  const id = s.sandbox_id || '';
  if (id.startsWith('sandbox-')) return id.slice(0, 14);
  if (id.length > 16) return id.slice(0, 12) + '…';
  return id || 'Workspace';
}

/** First two alphanumeric characters of the workspace name, uppercased. */
function workspaceInitials(s: SandboxInfo | null | undefined): string {
  if (!s) return 'W';
  const name = displayName(s);
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getCurrentInstanceIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const m = pathname.match(/^\/instances\/([^\/]+)/);
  return m ? m[1] : null;
}

// ─── Workspace avatar (shared between trigger + popover rows) ───────────────
//
// Square rounded tile with initials. Same DNA across the trigger pill and
// the dropdown rows so users build muscle memory for "that's my workspace".

function WorkspaceAvatar({
  sandbox,
  size = 'sm',
}: {
  sandbox: SandboxInfo | null;
  size?: 'sm' | 'xs';
}) {
  const dim = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-5 w-5 text-[9px]';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center rounded-md',
        'bg-foreground/[0.07] text-foreground/80 font-semibold',
        'flex-shrink-0 select-none',
        dim,
      )}
    >
      {workspaceInitials(sandbox)}
    </span>
  );
}

// ─── Collapsed-state exports ────────────────────────────────────────────────
//
// When the sidebar is in icon-only mode we don't render the full Slack-style
// pill — instead the workspace gets a collapsed icon button matching the
// session-list pattern: avatar of the current workspace, hover reveals
// a flyout panel with the workspace list.

/** Avatar (initials tile) of the currently-active workspace, sized for the
 *  collapsed icon rail. Falls back to a generic 'W' tile when no workspace
 *  is registered yet. */
export function CurrentWorkspaceAvatar() {
  const { user } = useAuth();
  const pathname = usePathname();
  const { data: sandboxes } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    enabled: !!user,
    staleTime: 30_000,
  });
  const visible = React.useMemo(
    () => (sandboxes ?? []).filter((s) => s.status !== 'archived'),
    [sandboxes],
  );
  const currentInstanceId = getCurrentInstanceIdFromPath(pathname);
  const activeServer = useServerStore((s) =>
    s.servers.find((srv) => srv.id === s.activeServerId),
  );
  const activeInstanceId = currentInstanceId || activeServer?.instanceId || null;
  const active = visible.find((s) => s.sandbox_id === activeInstanceId) ?? null;
  return <WorkspaceAvatar sandbox={active} size="xs" />;
}

/** Hover-flyout panel content for the collapsed sidebar. Mirrors the popover
 *  list but renders as plain DOM (no Command primitives) so it slots into
 *  CollapsedIconButton's flyout slot. */
export function WorkspacesFlyoutContent({
  onAfterAction,
}: {
  /** Called after the user picks a row / opens settings / triggers create.
   *  Lets the parent close the flyout. */
  onAfterAction?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const isCloud = isBillingEnabled();
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);
  const [settingsTarget, setSettingsTarget] = React.useState<SandboxInfo | null>(null);
  const [creatingLocal, setCreatingLocal] = React.useState(false);

  const { data: sandboxes, isLoading, refetch } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    enabled: !!user,
    staleTime: 30_000,
  });

  const visible = React.useMemo(
    () => (sandboxes ?? []).filter((s) => s.status !== 'archived'),
    [sandboxes],
  );

  const currentInstanceId = getCurrentInstanceIdFromPath(pathname);
  const activeServer = useServerStore((s) =>
    s.servers.find((srv) => srv.id === s.activeServerId),
  );
  const activeInstanceId = currentInstanceId || activeServer?.instanceId || null;

  const handleSelect = async (sandbox: SandboxInfo) => {
    onAfterAction?.();
    if (sandbox.sandbox_id === activeInstanceId) return;
    if (sandbox.status === 'active') {
      const result = await activateInstanceSelection(sandbox.sandbox_id, { pathname });
      router.push(result?.href ?? `/instances/${sandbox.sandbox_id}/dashboard`);
      return;
    }
    router.push(`/instances/${sandbox.sandbox_id}`);
  };

  const handleNewInstance = async () => {
    onAfterAction?.();
    if (isCloud) {
      openNewInstanceModal();
      return;
    }
    setCreatingLocal(true);
    try {
      await ensureSandbox();
      await refetch();
    } finally {
      setCreatingLocal(false);
    }
  };

  // Shared row styling — matches CommandItem's natural spec exactly so
  // the collapsed-sidebar flyout reads identical to the popover dropdown.
  const rowClass = cn(
    'group/row relative flex items-center gap-2 w-full rounded-lg px-2 py-1.5',
    'text-sm text-foreground/80 outline-hidden cursor-pointer transition-colors duration-75',
    'hover:bg-foreground/[0.06] hover:text-foreground',
    "[&_svg:not([class*='text-'])]:text-muted-foreground/65",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  );
  const iconColClass = 'shrink-0';

  return (
    <>
      <div className="p-1 flex flex-col">
        {isLoading && visible.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">
            No workspaces yet
          </div>
        ) : (
          visible.map((s) => {
            const isActive = s.sandbox_id === activeInstanceId;
            return (
              <button
                key={s.sandbox_id}
                type="button"
                onClick={() => handleSelect(s)}
                className={cn(
                  rowClass,
                  isActive && 'bg-foreground/[0.06] text-foreground',
                )}
              >
                <Box className={iconColClass} />
                <span
                  className={cn(
                    'flex-1 truncate text-left leading-tight',
                    isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground/85',
                  )}
                >
                  {displayName(s)}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Settings for ${displayName(s)}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onAfterAction?.();
                    setSettingsTarget(s);
                  }}
                  className={cn(
                    'flex items-center justify-center h-5 w-5 rounded-[4px] flex-shrink-0',
                    'text-muted-foreground/60 hover:text-foreground hover:bg-muted',
                    'opacity-0 group-hover/row:opacity-100 transition-opacity duration-150',
                  )}
                >
                  <Settings2 className="size-3" />
                </span>
                {isActive && <Check className="text-foreground" />}
              </button>
            );
          })
        )}
        <div className="border-t border-border/40 my-1" />
        <button
          type="button"
          onClick={handleNewInstance}
          disabled={creatingLocal}
          className={cn(rowClass, 'disabled:opacity-50 disabled:pointer-events-none')}
        >
          {creatingLocal ? <Loader2 className="animate-spin" /> : <Plus />}
          <span className="flex-1 text-left">
            {creatingLocal ? 'Creating…' : 'New workspace'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            onAfterAction?.();
            router.push('/instances');
          }}
          className={rowClass}
        >
          <ArrowUpRight />
          <span className="flex-1 text-left">All workspaces</span>
        </button>
      </div>

      <InstanceSettingsModal
        sandbox={settingsTarget}
        open={!!settingsTarget}
        onOpenChange={(o) => {
          if (!o) setSettingsTarget(null);
        }}
      />
    </>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InstanceSwitcherPopover() {
  const pathname = usePathname();
  const { user } = useAuth();

  const [open, setOpen] = React.useState(false);

  // Allow other components (e.g. the unreachable connecting screen's
  // "Switch workspace" button) to pop this switcher without a router push.
  React.useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-instance-switcher', handler);
    return () => window.removeEventListener('open-instance-switcher', handler);
  }, []);

  const { data: sandboxes } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.some((s) => s.status === 'provisioning')) return 15_000;
      return 60_000;
    },
  });

  const visible = React.useMemo(
    () => (sandboxes ?? []).filter((s) => s.status !== 'archived'),
    [sandboxes],
  );

  const currentInstanceId = getCurrentInstanceIdFromPath(pathname);
  const activeServer = useServerStore((s) =>
    s.servers.find((srv) => srv.id === s.activeServerId),
  );
  const activeInstanceId = currentInstanceId || activeServer?.instanceId || null;
  const triggerSandbox = visible.find((s) => s.sandbox_id === activeInstanceId) ?? null;
  const triggerLabel = triggerSandbox ? displayName(triggerSandbox) : 'Select workspace';

  return (
    <>
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'group/switcher flex items-center gap-2 w-full h-10 px-1.5 rounded-lg text-left',
              'text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-150 cursor-pointer',
              open && 'bg-sidebar-accent',
            )}
            aria-label="Switch workspace"
          >
            <WorkspaceAvatar sandbox={triggerSandbox} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="truncate text-[12.5px] font-semibold leading-tight text-foreground">
                {triggerLabel}
              </p>
              <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 leading-tight mt-0.5">
                Workspace
              </p>
            </div>
            <ChevronsUpDown className="size-3.5 opacity-50 flex-shrink-0 group-hover/switcher:opacity-100 transition-opacity" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className={cn(
            'w-[280px] p-0 overflow-hidden rounded-xl border-0',
            // Same dark slab surface as the unified dropdown system —
            // bg-card with hairline white inner border, soft drop, top-edge
            // gradient highlight. Identical material to DropdownMenuContent.
            'bg-card text-popover-foreground',
            'border border-border/60',
            'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/[0.08] before:to-transparent',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-[180ms] data-[state=closed]:duration-[140ms]',
          )}
        >
          <WorkspacesFlyoutContent onAfterAction={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </>
  );
}

