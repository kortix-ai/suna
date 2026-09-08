'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The settings sidebar — the 300px left column of the account hub modal.
 *
 * Top to bottom: `Back to app` with the search and collapse controls, the
 * **Accounts** group — every account the caller belongs to, the current one
 * highlighted with its sections nested under a hairline indent — and a footer
 * of two full-width rows, Docs and Help, in the same row dialect as the nav.
 * A person's own settings are not listed here; they live at
 * `/settings/<tab>`, outside this shell.
 *
 * Which sections the current account lists is `useAccountHubSection`'s
 * verdict, the same batched probe the body reads, so a nav item and its pane
 * can never disagree about whether this caller may open it.
 */

import {
  ArrowLeftIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
  QuestionIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Fragment, Suspense, useMemo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
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
import { openCommandPalette } from '@/features/workspace/open-command-palette';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { ACCOUNT_HUB_TRANSLATION_KEYS } from '@/i18n/account-hub-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { cn } from '@/lib/utils';
import { closeAccountPanel, hubTarget, type HubTarget } from '@/stores/account-panel-store';

import { HubLink, useAccountPanelId } from './account-hub-location';
import { localizedAccountNavGroups, type AccountNavItem } from './sections';
import { useAccountHubSection } from './use-account-hub-access';
import { useAccountMembers } from './use-account-members';

/**
 * One row dialect for every entry. Ink text on a translucent selected fill;
 * the glyph is muted until the row is the current one. No hover transition:
 * a sidebar row is hit tens of times a day and the highlight must not lag
 * the pointer.
 */
const ROW_CLASS =
  'text-foreground hover:bg-hover hover:text-foreground data-[active=true]:bg-active data-[active=true]:text-foreground [&_svg]:text-muted-foreground [&[data-active=true]_svg]:text-foreground';

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
          className={cn(
            'gap-2 px-2.5 py-1 font-normal transition-none has-[>svg]:px-2.5',
            'text-foreground data-[state=inactive]:text-foreground hover:bg-hover hover:text-foreground',
            'data-[state=active]:bg-active data-[state=active]:font-medium',
            '[&_svg]:text-muted-foreground data-[state=active]:[&_svg]:text-foreground',
          )}
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
  return (
    <div className="space-y-1 px-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full rounded-md" />
      ))}
    </div>
  );
}

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
  const accountsQuery = useAccountsList();
  const { sectionVisible, activeSection, canReadMembers } = useAccountHubSection(accountId);
  const membersQuery = useAccountMembers(accountId, canReadMembers);

  const accounts = useMemo(() => {
    const list = accountsQuery.data ?? [];
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [accountsQuery.data]);

  // `members` is `[]` for a caller without `member.read` — the query never
  // runs — and "0" beside Members on an account they are demonstrably a
  // member of is a lie, not a placeholder.
  const memberCount =
    sectionVisible.members && !membersQuery.isLoading ? (membersQuery.data ?? []).length : null;

  const sectionGroups = accountId
    ? navGroups
        .map((group) => ({
          label: group.label,
          items: group.items.filter((item) => sectionVisible[item.id]),
        }))
        .filter((group) => group.items.length > 0)
    : [];

  const sectionEntry = (item: AccountNavItem): NavEntry => ({
    key: `section:${item.id}`,
    label: item.label,
    to: hubTarget(accountId, { tab: item.id }),
    icon: item.icon,
    active: item.id === activeSection,
    trailing:
      item.id === 'members' && memberCount !== null ? (
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{memberCount}</span>
      ) : undefined,
  });

  const accountEntry = (account: { account_id: string; name?: string | null }): NavEntry => ({
    key: `account:${account.account_id}`,
    label: account.name || 'Account',
    to: hubTarget(account.account_id),
    active: account.account_id === accountId,
  });

  return (
    <>
      <SidebarGroup className="px-2 py-0">
        <GroupLabel>{tI18nComplete.raw('text8a7c8b67fe8b')}</GroupLabel>
        {accountsQuery.isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : accountsQuery.isError ? (
          <p className="text-muted-foreground px-2.5 py-2 text-xs">
            {tI18nComplete.raw('textb170e6a477b8')}
          </p>
        ) : (
          <SidebarMenu>
            {accounts.map((account) => {
              const current = account.account_id === accountId;
              return (
                <Fragment key={account.account_id}>
                  <NavRow entry={accountEntry(account)} />
                  {current && sectionGroups.length > 0 ? (
                    <li className="mt-1 mb-2.5 ml-2.5 border-l pl-1">
                      <ul
                        className="flex min-w-0 flex-col gap-px"
                        aria-label={`${account.name || 'Account'} settings`}
                      >
                        {sectionGroups.map((group, gi) => (
                          <Fragment key={group.label ?? gi}>
                            {gi > 0 ? <li aria-hidden className="h-3" /> : null}
                            {group.items.map((item) => (
                              <NavRow key={item.id} entry={sectionEntry(item)} />
                            ))}
                          </Fragment>
                        ))}
                      </ul>
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </>
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
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground hover:text-foreground gap-1 text-xs"
      onClick={() => closeAccountPanel()}
    >
      <ArrowLeftIcon className="size-4 shrink-0" />
      {label}
    </Button>
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
      <SidebarHeader className="gap-0 px-2 pt-0 pb-1">
        <div className="flex h-11 items-center justify-between py-2 pr-0.5">
          <BackToApp label={tI18nComplete.raw('texta6989680b352')} />
          <div className="flex items-center gap-px">
            <Hint label={tI18nComplete.raw('text49c266baaaa7')} side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tI18nComplete.raw('text49c266baaaa7')}
                onClick={() => openCommandPalette()}
              >
                <MagnifyingGlassIcon className="text-muted-foreground size-4" />
              </Button>
            </Hint>
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
