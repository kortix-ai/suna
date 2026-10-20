'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The settings sidebar — the 300px left column of the account hub modal.
 *
 * Top to bottom: a round back button, the account switcher (a pill with the
 * current account's name; it opens a menu of every account the caller
 * belongs to) and the collapse control; then the current
 * account's sections under their group labels (General, Access, Billing);
 * then a footer of two full-width rows, Docs and Help, in the same row
 * dialect as the nav.
 * A person's own settings are not listed here; they live at
 * `/settings/<tab>`, outside this shell.
 *
 * Which sections the current account lists is `useAccountHubSection`'s
 * verdict, the same batched probe the body reads, so a nav item and its pane
 * can never disagree about whether this caller may open it.
 */

import {
  BookOpenIcon,
  CaretLeftIcon,
  CaretUpDownIcon,
  CheckIcon,
  LifebuoyIcon,
  QuestionIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Suspense, useMemo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { backPillClass } from '@/components/ui/back-pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { ACCOUNT_HUB_TRANSLATION_KEYS } from '@/i18n/account-hub-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { closeAccountPanel, hubTarget, type HubTarget } from '@/stores/account-panel-store';

import { HubLink, useAccountPanelId } from './account-hub-location';
import { localizedAccountNavGroups, type AccountNavItem } from './sections';
import { useAccountHubSection } from './use-account-hub-access';
import { useAccountMembers } from './use-account-members';
import { CountBadge } from '@/components/ui/count-badge';

/**
 * One row dialect for every entry. Ink text on a translucent selected fill;
 * the glyph is muted until the row is the current one. No hover transition:
 * a sidebar row is hit tens of times a day and the highlight must not lag
 * the pointer.
 */
// The project sidebar's nav-row type: medium label, icon in the label colour
// (bold from IconProvider). Rows rest at 75% and the active one is full ink.
const ROW_CLASS =
  'text-sidebar-foreground/75 font-medium hover:bg-hover hover:text-sidebar-foreground data-[active=true]:bg-active data-[active=true]:text-sidebar-foreground';

// Reference destinations, read in a new tab so the settings you were editing
// stay put. Same two targets the user menu's Help group lists first.
const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string; icon: Icon }> = [
  { label: 'Docs', href: '/docs', icon: BookOpenIcon },
  { label: 'Support', href: '/support', icon: QuestionIcon },
];

interface NavEntry {
  key: string;
  label: string;
  to: HubTarget;
  icon?: Icon;
  active: boolean;
  trailing?: ReactNode;
}

function NavRow({ entry }: { entry: NavEntry }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const Glyph = entry.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={entry.active} className={ROW_CLASS}>
        <HubLink
          to={entry.to}
          aria-current={entry.active ? 'page' : undefined}
          onClick={() => {
            // The mobile sidebar is a sheet over the page; a pick closes it.
            if (isMobile) setOpenMobile(false);
          }}
          className="gap-2 px-2.5 py-1 font-medium transition-none has-[>svg]:px-2.5"
        >
          {Glyph ? <Glyph className="size-4 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          {entry.trailing}
        </HubLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <SidebarGroupLabel className="text-muted-foreground h-8 px-2.5 text-xs font-medium">
      {children}
    </SidebarGroupLabel>
  );
}

function NavSkeleton() {
  // The loaded nav's shape: three labelled groups of icon + label rows.
  return (
    <div className="space-y-4 px-2" aria-hidden>
      {NAV_SKELETON_GROUPS.map((rows, g) => (
        <div key={g} className="space-y-1">
          <Skeleton className="mx-2.5 my-2 h-3 w-14 rounded-sm" />
          {rows.map((width, i) => (
            <div key={i} className="flex h-8 items-center gap-2 px-2.5">
              <Skeleton className="size-4 shrink-0 rounded-sm" />
              <Skeleton className={`h-3.5 rounded-sm ${width}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** General, Access and Billing, with label widths that vary like real names. */
const NAV_SKELETON_GROUPS = [
  ['w-16', 'w-20', 'w-8', 'w-16'],
  ['w-20', 'w-16', 'w-16', 'w-12', 'w-16', 'w-20'],
  ['w-10', 'w-12'],
];

/**
 * The nav body. Reads `?tab=` through `useSearchParams`, so it renders under a
 * `Suspense` boundary — see `AccountSettingsSidebar`.
 */
function SettingsNav() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const navGroups = localizedAccountNavGroups(tI18nComplete);
  // From `?accountId=`, the only place it lives. `useParams()` would be
  // meaningless: this sidebar renders over some other route.
  const accountId = useAccountPanelId();
  const { sectionVisible, activeSection } = useAccountHubSection(accountId);
  const membersQuery = useAccountMembers(accountId);

  // The count of the people this caller sees: the whole directory with
  // `member.read`, else only the caller. Hidden while loading.
  const memberCount = membersQuery.isLoading ? null : (membersQuery.data ?? []).length;

  // The account list (no account picked) has no sections: the switcher above
  // and the list in the body are the whole page.
  if (!accountId) return null;

  const sectionGroups = navGroups
    .map((group) => ({
      // The plumbing group has no name in `NAV_GROUPS`; in the sidebar it
      // reads as "General" so every group carries a label.
      label: group.label ?? tI18nComplete.raw('textc910d474dcd7'),
      // Help sits in the footer beside Docs and Support: reference, not a setting.
      items: group.items.filter((item) => sectionVisible[item.id]).filter((item) => item.id !== 'help'),
    }))
    .filter((group) => group.items.length > 0);

  const sectionEntry = (item: AccountNavItem): NavEntry => ({
    key: `section:${item.id}`,
    label: item.label,
    to: hubTarget(accountId, { tab: item.id }),
    icon: item.icon,
    active: item.id === activeSection,
    trailing:
      item.id === 'members' && memberCount !== null ? (
        <CountBadge count={memberCount} className="ml-auto" />
      ) : undefined,
  });

  return (
    <>
      {sectionGroups.map((group) => (
        <SidebarGroup key={group.label} className="px-2 py-0 pb-3">
          <GroupLabel>{group.label}</GroupLabel>
          <SidebarMenu aria-label={group.label}>
            {group.items.map((item) => (
              <NavRow key={item.id} entry={sectionEntry(item)} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}

/**
 * The account switcher, top-left after the back button. A ghost pill with
 * the current account's name, the back pill's shape without its chevron. The
 * menu lists every account the caller belongs to, a check on the current one;
 * a pick opens that account's hub at its default section.
 */
function AccountSwitcher() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountId = useAccountPanelId();
  const accountsQuery = useAccountsList();

  const accounts = useMemo(() => {
    const list = accountsQuery.data ?? [];
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [accountsQuery.data]);

  const accountsLabel = tI18nComplete.raw('text8a7c8b67fe8b');
  const current = accounts.find((account) => account.account_id === accountId);
  const label = current ? current.name || 'Account' : accountsLabel;

  if (accountsQuery.isLoading) return <Skeleton className="h-7 w-28 rounded-full" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="xs"
          className={backPillClass('max-w-48 min-w-0 has-[>svg]:pr-2 has-[>svg]:pl-3 max-sm:size-auto max-sm:has-[>svg]:px-2.5')}
        >
          <span className="min-w-0 truncate">{label}</span>
          <CaretUpDownIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-muted-foreground mb-1 text-xs font-medium">
          {accountsLabel}
        </DropdownMenuLabel>
        {accountsQuery.isError ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            {tI18nComplete.raw('textb170e6a477b8')}
          </p>
        ) : (
          accounts.map((account) => {
            const selected = account.account_id === accountId;
            return (
              <DropdownMenuItem key={account.account_id} asChild>
                <HubLink to={hubTarget(account.account_id)} aria-current={selected ? 'page' : undefined}>
                  <span className="min-w-0 flex-1 truncate">{account.name || 'Account'}</span>
                  {selected ? <CheckIcon aria-hidden className="size-4 shrink-0" /> : null}
                </HubLink>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The one way out, top-left.
 *
 * It closes, it does not navigate: the page you came from is still mounted
 * underneath, and `closeAccountPanel` pops the single history entry the modal
 * pushed — so you land exactly where you were, at the scroll position you
 * left. Same effect as Escape.
 */
function BackToApp({ label }: { label: string }) {
  return (
    <Hint label={label} side="bottom">
      <Button
        variant="secondary"
        size="icon"
        aria-label={label}
        className="shrink-0 rounded-full"
        onClick={() => closeAccountPanel()}
      >
        <CaretLeftIcon aria-hidden className="size-3.5" />
      </Button>
    </Hint>
  );
}

/** The account's Help pane, listed in the footer above Docs and Support. */
function HelpRow({ label }: { label: string }) {
  const accountId = useAccountPanelId();
  const { activeSection } = useAccountHubSection(accountId);
  if (!accountId) return null;
  return (
    <NavRow
      entry={{
        key: 'section:help',
        label,
        to: hubTarget(accountId, { tab: 'help' }),
        icon: LifebuoyIcon,
        active: activeSection === 'help',
      }}
    />
  );
}

export function AccountSettingsSidebar() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const footerLinks = localizeUiCatalog(FOOTER_LINKS, tI18nComplete, ACCOUNT_HUB_TRANSLATION_KEYS);
  return (
    // `--surface` is this shell's pane color, one rung off canvas. The child
    // variant is required: `className` lands on the positioning container,
    // while the box that paints `bg-background` is `sidebar-inner` inside it.
    <Sidebar
      collapsible="offcanvas"
      variant="sidebar"
      className="bg-surface [&>[data-slot=sidebar-inner]]:bg-surface"
    >
      <SidebarHeader className="gap-0 px-2 pt-0 pb-0">
        <div className="kx-titlebar-row kx-titlebar-band-height kx-overlay-sidebar-titlebar flex h-11 items-center justify-between gap-1 py-2 pr-0.5">
          <div className="flex min-w-0 items-center gap-0.5">
            <BackToApp label={tI18nComplete.raw('texta6989680b352')} />
            <Suspense fallback={<Skeleton className="h-7 w-28 rounded-full" />}>
              <AccountSwitcher />
            </Suspense>
          </div>
          <div className="flex shrink-0 items-center gap-px">
            <Hint label={tI18nComplete.raw('textd1db29ebc76d')} side="bottom">
              <SidebarTrigger className="text-muted-foreground" />
            </Hint>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0 bg-inherit">
        <Suspense fallback={<NavSkeleton />}>
          <SettingsNav />
        </Suspense>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <Suspense fallback={null}>
            <HelpRow label={tI18nComplete.raw('textb79cac926e0b')} />
          </Suspense>
          {footerLinks.map((link) => (
            <SidebarMenuItem key={link.href}>
              <SidebarMenuButton asChild className={ROW_CLASS}>
                <a href={link.href} target="_blank" rel="noreferrer">
                  <link.icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{link.label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
