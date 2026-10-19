'use client';

import { BackPillBody, backPillClass } from '@kortix/ui/back-pill';
import { Button } from '@kortix/ui/button';
import { ModalClose } from '@kortix/ui/modal';
import { TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { workspaceAccountLabel } from '@kortix/ui/workspace/sidebar/workspace-grouping';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import type { SettingsRailChromeCopy } from '@kortix/ui/customize/settings/rail-copy-context';
import {
  accountRoleLabel,
  type AccountMembership,
  type AccountMembershipsCopy,
} from './tabs/account-memberships';
import type { RailGroup, RailItem } from '@kortix/ui/customize/settings/type';
export function RailNav({
  groups,
  showGroupLabels,
  organizations,
  organizationCopy,
  chrome,
  onPick,
  className,
}: {
  groups: readonly RailGroup[];
  showGroupLabels: boolean;
  organizations: readonly AccountMembership[];
  organizationCopy: AccountMembershipsCopy;
  chrome: SettingsRailChromeCopy;
  onPick?: () => void;
  className?: string;
}) {
  return (
    <nav
      aria-label={chrome.settings}
      className={cn(
        'flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-2 pb-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {groups.filter((group) => !group.footer).map((group) => (
        <div key={group.label}>
          {showGroupLabels ? (
            <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs font-medium">
              {group.label}
            </div>
          ) : null}
          <TabsList orientation="vertical" className="w-full">
            {group.items.map((item) => (
              <TabsTrigger
                key={item.tab}
                value={item.tab}
                size="md"
                // Runs on every tap, so mobile opens the pane even for the row
                // already selected (Radix fires no value change for it).
                onClick={onPick}
                className={cn(
                  // The project sidebar's nav-row type: medium label,
                  // icon in the label colour (bold from IconProvider).
                  // Rows rest at 75%; the active one is full ink.
                  'gap-2 px-2.5 py-1 font-medium transition-none has-[>svg]:px-2.5',
                  'data-[state=inactive]:text-sidebar-foreground/75 hover:bg-hover data-[state=inactive]:hover:text-sidebar-foreground',
                  'data-[state=active]:bg-active data-[state=active]:text-sidebar-foreground',
                )}
              >
                <RailTriggerBody item={item} />
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      ))}

      {organizations.length > 0 ? (
        /* The organizations the person belongs to. Each row LEAVES the
         overlay for that organization's own settings page — members,
         billing, roles, audit all live there — so it is a link that
         closes the dialog, not a tab. Same row footprint as the tabs
         above so the rail reads as one list with two kinds of row. */
        <div>
          <div className="text-muted-foreground flex h-7 items-center px-2.5 text-xs font-medium">
            {organizationCopy.title}
          </div>
          <ul className="flex flex-col gap-0.5">
            {organizations.map((account) => (
              <li key={account.account_id}>
                <ModalClose asChild>
                  <HubLink
                    to={hubTarget(account.account_id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 pt-1 pb-1.5 text-sm font-medium',
                      'text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground transition-colors',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {workspaceAccountLabel(
                          account.name,
                          organizationCopy.fallbackAccountName,
                          false,
                        )}
                      </span>
                      {accountRoleLabel(account.account_role, organizationCopy) ? (
                        <span className="text-muted-foreground block truncate text-xs font-normal">
                          {accountRoleLabel(account.account_role, organizationCopy)}
                        </span>
                      ) : null}
                    </span>
                  </HubLink>
                </ModalClose>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groups
        .filter((group) => group.footer)
        .map((group) => (
          <RailFooterGroup key={group.label} group={group} onPick={onPick} />
        ))}
    </nav>
  );
}

/**
 * The Connect group at the foot of the rail (KRTX-1997): the same two rows the
 * project sidebar footer shows — one block, 1px seam, inner corners
 * `rounded-sm`, a "New" badge — but each is a tab here, so it opens its page
 * in this dialog, and none can be dismissed. `aria-label` names the list for
 * screen readers, which hear no group heading.
 */
function RailFooterGroup({ group, onPick }: { group: RailGroup; onPick?: () => void }) {
  const tSidebar = useI18nTranslations('sidebar');
  return (
    <TabsList
      orientation="vertical"
      aria-label={group.label}
      className="mt-auto w-full gap-px [&>button:not(:first-child)]:rounded-t-sm [&>button:not(:last-child)]:rounded-b-sm"
    >
      {group.items.map((item) => (
        <TabsTrigger
          key={item.tab}
          value={item.tab}
          size="md"
          onClick={onPick}
          className={cn(
            'bg-hover text-sidebar-foreground gap-2 px-2.5 py-1 font-medium transition-none has-[>svg]:px-2.5',
            'hover:bg-active data-[state=active]:bg-active data-[state=active]:text-sidebar-foreground',
          )}
        >
          <RailTriggerBody item={item} />
          <span className="bg-kortix-blue/15 text-kortix-blue ms-auto flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs font-medium">
            {tSidebar('new')}
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function RailTriggerBody({ item, horizontal = false }: { item: RailItem; horizontal?: boolean }) {
  const Icon = item.icon;
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
    </>
  );
}

export function SettingsRail({
  isMobile,
  mobilePane,
  railProps,
  closeButton,
  onPick,
}: {
  isMobile: boolean;
  mobilePane: boolean;
  railProps: React.ComponentProps<typeof RailNav>;
  closeButton: React.ReactNode;
  onPick: () => void;
}) {
  const chrome = railProps.chrome;
  return isMobile ? (
    /* Mobile is two screens, like a phone's Settings app: this list,
             then the picked pane with a back pill (in <main> below). The old
             tab strip clipped every label past the third at phone width. */
    mobilePane ? null : (
      <div className="flex min-h-0 flex-1 flex-col bg-inherit">
        <header
          className="kx-titlebar-row kx-titlebar-band-height kx-settings-mobile-titlebar flex h-11 shrink-0 items-center justify-between border-b px-2"
          data-sidebar-collapsed=""
        >
          <span className="px-2 text-sm font-medium">{chrome.settings}</span>
          {closeButton}
        </header>
        <RailNav {...railProps} className="pt-2" onPick={onPick} />
      </div>
    )
  ) : (
    /* The settings sidebar, as `/accounts/[id]` draws it
           (`accounts/hub/account-settings-sidebar.tsx`): one column — the
           `Back to app` row on top, then the rows. Same background as the
           content — the hairline is the only seam. */
    <aside className="flex min-h-0 flex-col border-r bg-inherit">
      <div className="kx-titlebar-row kx-titlebar-band-height kx-overlay-sidebar-titlebar flex h-11 shrink-0 items-center justify-start px-2">
        <ModalClose asChild>
          <Button variant="ghost" size="xs" className={backPillClass()}>
            <BackPillBody label={chrome.backToApp} />
          </Button>
        </ModalClose>
      </div>
      <RailNav {...railProps} />
    </aside>
  );
}
