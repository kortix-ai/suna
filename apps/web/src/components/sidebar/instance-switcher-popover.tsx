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
  Check,
  ChevronsUpDown,
  Loader2,
  Plus,
  Settings2,
} from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/button';
import {
  CommandPopover,
  CommandPopoverTrigger,
  CommandPopoverContent,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
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
// Sessions/Projects pattern: avatar of the current workspace, hover reveals
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

  return (
    <>
      <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        Workspaces
      </div>
      <div className="overflow-y-auto py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {isLoading && visible.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground/60">
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
                  'group/row flex items-center gap-2 w-full px-2 py-1.5 text-[13px] cursor-pointer transition-colors duration-100',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                )}
              >
                <WorkspaceAvatar sandbox={s} size="xs" />
                <span
                  className={cn(
                    'flex-1 truncate text-left',
                    isActive && 'font-semibold text-foreground',
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
                    'flex items-center justify-center h-6 w-6 rounded-md flex-shrink-0',
                    'text-muted-foreground/60 hover:text-foreground hover:bg-muted',
                    'opacity-0 group-hover/row:opacity-100 transition-opacity duration-150',
                  )}
                >
                  <Settings2 className="size-3" />
                </span>
                {isActive && <Check className="size-3.5 text-foreground shrink-0" />}
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-border/50 p-1 flex flex-col">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNewInstance}
          disabled={creatingLocal}
          className="w-full justify-start gap-2 text-[12.5px] font-normal h-8 px-2"
        >
          {creatingLocal ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {creatingLocal ? 'Creating…' : 'New workspace'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onAfterAction?.();
            router.push('/instances');
          }}
          className="w-full justify-start gap-2 text-[12.5px] font-normal h-8 px-2"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          All workspaces
        </Button>
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
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const isCloud = isBillingEnabled();
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [settingsTarget, setSettingsTarget] = React.useState<SandboxInfo | null>(null);
  const [creatingLocal, setCreatingLocal] = React.useState(false);

  React.useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // Allow other components (e.g. the unreachable connecting screen's
  // "Switch workspace" button) to pop this switcher without a router push.
  React.useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-instance-switcher', handler);
    return () => window.removeEventListener('open-instance-switcher', handler);
  }, []);

  const { data: sandboxes, isLoading, refetch } = useQuery({
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

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((s) =>
      [s.name, s.sandbox_id].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [visible, search]);

  const currentInstanceId = getCurrentInstanceIdFromPath(pathname);
  const activeServer = useServerStore((s) =>
    s.servers.find((srv) => srv.id === s.activeServerId),
  );
  const activeInstanceId = currentInstanceId || activeServer?.instanceId || null;
  const active = visible.find((s) => s.sandbox_id === activeInstanceId) ?? null;
  // Fall back to the first known workspace ONLY for display. We never auto-pick
  // it as "active" — that would lie about which workspace the user is in.
  const triggerSandbox = active ?? null;
  const triggerLabel = triggerSandbox ? displayName(triggerSandbox) : 'Select workspace';

  const handleSelect = async (sandbox: SandboxInfo) => {
    setOpen(false);
    if (sandbox.sandbox_id === activeInstanceId) return;
    if (sandbox.status === 'active') {
      const result = await activateInstanceSelection(sandbox.sandbox_id, { pathname });
      router.push(result?.href ?? `/instances/${sandbox.sandbox_id}/dashboard`);
      return;
    }
    router.push(`/instances/${sandbox.sandbox_id}`);
  };

  const handleSettings = (sandbox: SandboxInfo) => {
    setOpen(false);
    setSettingsTarget(sandbox);
  };

  const handleNewInstance = async () => {
    setOpen(false);
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

  return (
    <>
      <CommandPopover open={open} onOpenChange={setOpen} modal={false}>
        <CommandPopoverTrigger>
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
        </CommandPopoverTrigger>

        <CommandPopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-[280px]"
        >
          {visible.length > 4 && (
            <CommandInput
              compact
              placeholder="Search workspaces…"
              value={search}
              onValueChange={setSearch}
            />
          )}

          <CommandList className="max-h-[320px]">
            <CommandGroup heading={visible.length > 0 ? 'Workspaces' : undefined} forceMount>
              {isLoading && visible.length === 0 ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading…
                </div>
              ) : filtered.length === 0 && search.trim() ? (
                <div className="py-6 text-center text-xs text-muted-foreground/60">
                  No workspaces match &ldquo;{search.trim()}&rdquo;
                </div>
              ) : visible.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground/60">
                  No workspaces yet
                </div>
              ) : (
                filtered.map((s) => {
                  const isActive = s.sandbox_id === activeInstanceId;
                  return (
                    <CommandItem
                      key={s.sandbox_id}
                      value={`workspace-${s.sandbox_id}-${s.name ?? ''}`}
                      onSelect={() => handleSelect(s)}
                      className="group/row gap-2"
                    >
                      <WorkspaceAvatar sandbox={s} size="xs" />
                      <div className="flex-1 min-w-0">
                        <span
                          className={cn(
                            'truncate text-[12.5px] leading-tight block',
                            isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground/90',
                          )}
                        >
                          {displayName(s)}
                        </span>
                        {s.version && (
                          <p className="text-[10.5px] text-muted-foreground/45 leading-tight truncate">
                            v{s.version}
                          </p>
                        )}
                      </div>
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
                          handleSettings(s);
                        }}
                        className={cn(
                          'flex items-center justify-center h-6 w-6 rounded-md cursor-pointer flex-shrink-0',
                          'text-muted-foreground/60 hover:text-foreground hover:bg-muted',
                          'opacity-0 group-hover/row:opacity-100 group-data-[selected=true]:opacity-100',
                          'transition-opacity duration-150',
                        )}
                      >
                        <Settings2 className="size-3" />
                      </span>
                      {isActive && (
                        <Check className="size-3.5 text-foreground shrink-0" />
                      )}
                    </CommandItem>
                  );
                })
              )}
            </CommandGroup>
          </CommandList>

          <div className="border-t border-border/50 p-1 flex flex-col">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNewInstance}
              disabled={creatingLocal}
              className="w-full justify-start gap-2 text-[12.5px] font-normal h-8 px-2"
            >
              {creatingLocal ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {creatingLocal ? 'Creating…' : 'New workspace'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                router.push('/instances');
              }}
              className="w-full justify-start gap-2 text-[12.5px] font-normal h-8 px-2"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              All workspaces
            </Button>
          </div>
        </CommandPopoverContent>
      </CommandPopover>

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
