'use client';

/**
 * The workspace list inside the sidebar's "Switch workspace" submenu: search,
 * pending invitations, then every workspace the caller belongs to as ONE flat
 * list, the current one checked. A workspace is one account and its project,
 * so there are no account headings (`useWorkspaceDirectory`).
 *
 * The host passes the bottom actions ("Create workspace", "Workspace
 * settings") as `actions`: whether the caller may create a workspace depends
 * on the host's instance config. Nothing here reads until the submenu opens.
 *
 * Rendered INSIDE an open `DropdownMenuSubContent`, so it emits menu children
 * only: no `DropdownMenu`, no trigger, no portal of its own.
 */

import { CheckIcon, MagnifyingGlassIcon, MonitorPlayIcon } from '@phosphor-icons/react';
import { useCaptureWorkspace } from '@kortix/sdk/react';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { captureHref } from '../../internal/capture/use-capture-area';
import { isModifiedClick } from '../../internal/lib/navigation/modified-click';
import { cn } from '../../internal/lib/utils';
import { useCurrentAccountStore } from '../../internal/stores/current-account-store';
import {
  shouldShowProjectSwitchLoading,
  useProjectSwitchStore,
} from '../../internal/stores/project-switch-store';
import { isProjectPath, uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from '../../primitives/dropdown-menu';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link, useUiPathname, useUiRouter } from '../../providers/ui-provider';
import { errorToast } from '../../primitives/toast';
import { useSessionIds } from '../../providers/session-ids';
import { filterWorkspaceRows, formatWorkspaceDate, type WorkspaceRow } from '../project-selector/project-selector-model';
import { useWorkspaceStateActions } from './use-workspace-list';
import { InvitationsMenuGroup } from './invitations-menu-group';
import { useWorkspaceDirectory, type WorkspaceDirectory } from './use-workspace-directory';

export function WorkspaceMenuSection({
  actions,
}: {
  /** The bottom rows. A render prop: whether the caller may create a
   *  workspace reads the directory this submenu already loaded. */
  actions?: (directory: WorkspaceDirectory) => ReactNode;
}) {
  const t = useTranslations('workspaces.switcher');
  const tCapture = useTranslations('capture.account');
  const pathname = useUiPathname();
  const { projectId: routeProjectId } = useSessionIds();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useProjectSwitchStore((s) => s.beginSwitch);
  const switchingToProjectId = useProjectSwitchStore((s) => s.targetProjectId);
  const [query, setQuery] = useState('');
  const directory = useWorkspaceDirectory();
  const tChooser = useTranslations('workspaces.chooser');
  const locale = useLocale();
  const router = useUiRouter();
  const stateActions = useWorkspaceStateActions((workspaceId) => router.push(uiRoutes().project(workspaceId)));

  const activeProjectId =
    routeProjectId && isProjectPath(pathname, routeProjectId) ? routeProjectId : undefined;
  const visible = useMemo(() => filterWorkspaceRows(directory.workspaces, query), [directory.workspaces, query]);
  const activeAccountId =
    directory.workspaces.find((row) => row.workspaceId === activeProjectId)?.accountId ?? selectedAccountId;
  // Kortix Capture is a workspace feature: the menu links to it once it is on.
  const captureOn = useCaptureWorkspace(activeAccountId ?? null).data?.enabled ?? false;

  // Side effects only: the row IS the anchor and carries the navigation. A
  // modified click opens a new tab, so this tab's state must not move.
  const startSwitch = (event: MouseEvent<HTMLAnchorElement>, row: WorkspaceRow) => {
    if (row.workspaceId === activeProjectId || isModifiedClick(event)) return;
    beginSwitch(row.workspaceId);
    // Account-scoped surfaces answer for the workspace being opened.
    if (row.accountId !== selectedAccountId) setSelectedAccountId(row.accountId);
  };

  return (
    <>
      {/* Always mounted: this list is the whole directory, so a conditional
          search box would make workspace N+7 unreachable. */}
      <div className="p-0.5">
        <div className="relative">
          <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('find')}
            aria-label={t('find')}
            // A Radix menu runs typeahead on printable keys and moves focus off
            // the field. Stopping propagation keeps the keystrokes here.
            onKeyDown={(e) => e.stopPropagation()}
            className="h-8 pr-2 pl-8 text-sm"
          />
        </div>
      </div>

      <InvitationsMenuGroup />

      {/* Bounded so a long list scrolls inside the submenu rather than growing
          it past the viewport. */}
      <div
        className="max-h-[640px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        data-testid="switcher-workspaces"
      >
        {directory.loading ? (
          <div className="space-y-1 p-1">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-7 rounded-md" />
            ))}
          </div>
        ) : visible.length === 0 && query.trim() ? (
          <div className="text-muted-foreground px-2 py-3 text-xs">{t('noMatches')}</div>
        ) : (
          <DropdownMenuGroup className="p-0.5">
            {visible.map((row) => {
              if (row.state !== 'active') {
                const acting =
                  (stateActions.setup.isPending && stateActions.setup.variables === row.workspaceId) ||
                  (stateActions.restore.isPending && stateActions.restore.variables === row.workspaceId);
                return (
                  <DropdownMenuItem
                    key={row.workspaceId}
                    className="cursor-pointer px-1.5"
                    disabled={acting}
                    data-state={row.state}
                    // Keep the menu open while the action runs; navigation closes it.
                    onSelect={(event) => {
                      event.preventDefault();
                      (row.state === 'deleting' ? stateActions.restore : stateActions.setup).mutate(row.workspaceId, {
                        onError: (error: Error) => errorToast(error.message || tChooser('stateActionError')),
                      });
                    }}
                  >
                    <EntityAvatar label={row.project.name} glyph={row.project.icon_glyph} emoji={row.project.icon} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="text-muted-foreground block truncate text-sm font-medium">{row.project.name}</span>
                      {row.state === 'deleting' ? (
                        <span className="text-muted-foreground block truncate text-xs">
                          {tChooser('deletingOn', { date: formatWorkspaceDate(row.deletionScheduledFor, locale) })}
                        </span>
                      ) : null}
                    </span>
                    {acting ? (
                      <Loading className="text-muted-foreground size-3.5" />
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        {row.state === 'deleting' ? tChooser('restore') : tChooser('setUp')}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              }
              const active = row.workspaceId === activeProjectId;
              // Only the row you clicked, and only until the URL is on it.
              const loading = shouldShowProjectSwitchLoading(
                switchingToProjectId,
                row.workspaceId,
                activeProjectId ?? null,
              );
              return (
                <DropdownMenuItem
                  key={row.workspaceId}
                  asChild
                  disabled={loading}
                  className={cn('cursor-pointer px-1.5', active && 'bg-muted')}
                >
                  {/* Default `auto` prefetch: a forced full prefetch would
                      render one RSC payload per row on every submenu open. */}
                  <Link
                    href={uiRoutes().project(row.workspaceId)}
                    aria-current={active ? 'page' : undefined}
                    onClick={(event) => startSwitch(event, row)}
                  >
                    <EntityAvatar
                      label={row.project.name}
                      glyph={row.project.icon_glyph}
                      emoji={row.project.icon}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.project.name}</span>
                    {loading ? (
                      <Loading className="text-muted-foreground size-3.5" />
                    ) : active ? (
                      <CheckIcon className="text-foreground size-4 shrink-0" aria-hidden />
                    ) : null}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        )}
        {/* Not filtered by `query`: a match could be inside the account that
            failed, so hiding this on a search would say something false. */}
        {directory.failedAccountIds.length > 0 ? (
          <div className="text-muted-foreground flex w-full items-center gap-2 px-2.5 text-xs">
            <span className="min-w-0 flex-1 truncate">{t('loadError')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={directory.retryFailed} className="shrink-0">
              {t('retry')}
            </Button>
          </div>
        ) : null}
      </div>

      {actions || (captureOn && activeAccountId) ? (
        <>
          <DropdownMenuSeparator />
          <div className="p-0.5">
            {actions?.(directory)}
            {captureOn && activeAccountId ? (
              <DropdownMenuItem asChild className="cursor-pointer px-1.5" size="sm">
                <Link href={captureHref(activeAccountId, 'devices')}>
                  <MonitorPlayIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{tCapture('title')}</span>
                </Link>
              </DropdownMenuItem>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
