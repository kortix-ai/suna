'use client';

import { acceptAccountInvite, type KortixProject, type MyAccountInvite } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  ArrowRightIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { isModifiedClick } from '@/lib/navigation/modified-click';
import { writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import {
  COLLAPSED_PROJECT_LIMIT,
  SEARCH_THRESHOLD,
  countProjects,
  filterSections,
  joinDestination,
  type AccountSection,
} from './project-selector-model';
import { useProjectSelectorData } from './use-project-selector-data';

/**
 * `/projects` — choose a project, Slack-style.
 *
 * One column, top to bottom: the create card, pending invites, then every
 * account the user belongs to with its projects. Every user state renders
 * here — see `project-selector-model.ts` for the list — so nobody is ever
 * pushed into the create form when they have something to open.
 */
export interface ProjectSelectorViewProps {
  email: string | null;
  loading: boolean;
  loadFailed: boolean;
  sections: AccountSection[];
  invites: MyAccountInvite[];
  /** Any account where the user may create a project. */
  createHref: string | null;
  joiningInviteId: string | null;
  openingProjectId: string | null;
  signingOut: boolean;
  onJoin: (invite: MyAccountInvite) => void;
  onOpenProject: (event: MouseEvent<HTMLAnchorElement>, project: KortixProject) => void;
  onRetryAccount: (accountId: string) => void;
  onRetryAll: () => void;
  onLogOut: () => void;
}

export function ProjectSelectorView(props: ProjectSelectorViewProps) {
  const t = useTranslations('projectSelector');
  const { email, loading, loadFailed, sections, invites, createHref } = props;
  const [query, setQuery] = useState('');

  const total = countProjects(sections);
  const visible = useMemo(() => filterSections(sections, query), [sections, query]);
  const hasAnything = total > 0 || invites.length > 0;
  // The create card already targets one account; its empty row would say the
  // same thing twice. Other empty accounts keep their own create row.
  const listed = sections.filter(
    (section) =>
      !(
        section.state === 'empty-creatable' &&
        newWorkspacePathForAccount(section.accountId) === createHref
      ),
  );
  const noAccess = !loading && !loadFailed && !createHref && !hasAnything;

  const title = total > 0 ? t('welcomeBack') : t('welcome');
  const description = noAccess
    ? t('noAccessBody', { email: email ?? '' })
    : total > 0
      ? t('descriptionReturning')
      : t('descriptionNew');

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col px-6 py-20">
      <TopBar email={email} signingOut={props.signingOut} onLogOut={props.onLogOut} />

      {/* `my-auto` centers the block in the viewport while it fits, and lets
          it start at the top and scroll once the project list is taller.
          Blank while the reads resolve (one round trip): a centered block
          that changes height would slide the header down under the eye. */}
      {loading ? null : (
        <div className="my-auto w-full">
          <header className="flex flex-col items-center gap-2 text-center">
            <KortixLogo size={28} variant="icon" className="mb-3" />
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">
              {noAccess ? t('noAccessTitle') : title}
            </h1>
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          </header>

          {loadFailed ? (
            <div className="mt-10 flex flex-col items-center gap-3 text-center">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('loadErrorTitle')}</p>
                <p className="text-muted-foreground text-xs">{t('loadErrorBody')}</p>
              </div>
              <Button size="sm" variant="outline" onClick={props.onRetryAll}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <div className="mt-10 flex flex-col gap-8">
              {createHref ? <CreateCard href={createHref} /> : null}

              {createHref && hasAnything ? (
                <div className="flex items-center gap-3" aria-hidden>
                  <span className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground text-xs">{t('orContinue')}</span>
                  <span className="bg-border h-px flex-1" />
                </div>
              ) : null}

              {invites.length > 0 ? (
                <section className="space-y-3" data-testid="selector-invites">
                  <SectionHeading
                    title={t('invitations')}
                    meta={email ? t('sentTo', { email }) : null}
                  />
                  <ul className="space-y-2">
                    {invites.map((invite) => (
                      <InviteRow
                        key={invite.invite_id}
                        invite={invite}
                        joining={props.joiningInviteId === invite.invite_id}
                        disabled={props.joiningInviteId !== null}
                        onJoin={props.onJoin}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {total > SEARCH_THRESHOLD ? (
                <div className="relative">
                  <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('search')}
                    aria-label={t('search')}
                    className="pl-9"
                  />
                </div>
              ) : null}

              {query.trim() && visible.length === 0 ? (
                <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                  {t('noMatches', { query: query.trim() })}
                </p>
              ) : null}

              {(query.trim() ? visible : listed).map((section) => (
                <AccountBlock
                  key={section.accountId}
                  section={section}
                  expandedByQuery={query.trim().length > 0}
                  openingProjectId={props.openingProjectId}
                  onOpenProject={props.onOpenProject}
                  onRetry={props.onRetryAccount}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function TopBar({
  email,
  signingOut,
  onLogOut,
}: {
  email: string | null;
  signingOut: boolean;
  onLogOut: () => void;
}) {
  const t = useTranslations('projectSelector');
  const tNew = useTranslations('newWorkspace');
  // `kx-desktop-band-row` keeps the row under the desktop title-bar band,
  // clear of the macOS traffic lights and the Win/Linux window controls.
  return (
    <div className="kx-desktop-band-row absolute inset-x-0 top-3 z-10 flex items-center justify-end gap-3 px-4 sm:top-4 sm:px-6">
      {email ? (
        <span className="text-muted-foreground hidden min-w-0 truncate text-xs sm:inline">
          {t('signedInAs', { email })}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground shrink-0"
        disabled={signingOut}
        onClick={onLogOut}
      >
        {signingOut ? <Loading className="size-4 shrink-0" /> : null}
        {signingOut ? tNew('actions.signingOut') : tNew('actions.logOut')}
      </Button>
    </div>
  );
}

function SectionHeading({ title, meta }: { title: string; meta: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Label className="min-w-0 truncate">{title}</Label>
      {meta ? <span className="text-muted-foreground shrink-0 text-xs">{meta}</span> : null}
    </div>
  );
}

function CreateCard({ href }: { href: string }) {
  const t = useTranslations('projectSelector');
  return (
    <Link
      href={href}
      prefetch
      data-testid="selector-create"
      className="group bg-popover hover:bg-hover focus-visible:ring-ring flex items-center gap-3 rounded-md border px-4 py-3.5 transition-colors outline-none focus-visible:ring-2"
    >
      <span className="bg-foreground text-background flex size-10 shrink-0 items-center justify-center rounded-md">
        <PlusIcon className="size-5" />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="text-foreground block text-sm font-medium">{t('createTitle')}</span>
        <span className="text-muted-foreground block text-xs">{t('createBody')}</span>
      </span>
      <CaretRightIcon className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
    </Link>
  );
}

function InviteRow({
  invite,
  joining,
  disabled,
  onJoin,
}: {
  invite: MyAccountInvite;
  joining: boolean;
  disabled: boolean;
  onJoin: (invite: MyAccountInvite) => void;
}) {
  const t = useTranslations('projectSelector');
  const workspace = invite.account_name ?? t('unnamedWorkspace');
  // A project invite leads with the project: that is where Join lands.
  const hasProjects = invite.projects.length > 0;
  const title = hasProjects ? invite.projects.map((p) => p.name).join(', ') : workspace;

  return (
    <li className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
      <EntityAvatar label={title} size="lg" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground truncate text-sm font-medium">{title}</p>
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          {hasProjects ? <span className="shrink-0">{workspace}</span> : null}
          {hasProjects && invite.inviter_email ? (
            <span aria-hidden className="text-muted-foreground/40">
              {'•'}
            </span>
          ) : null}
          {invite.inviter_email ? (
            <span className="truncate">{t('invitedBy', { email: invite.inviter_email })}</span>
          ) : null}
        </p>
      </div>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => onJoin(invite)}
        className="shrink-0 gap-1.5"
      >
        {joining ? <Loading className="size-3.5 shrink-0" /> : null}
        {t('join')}
      </Button>
    </li>
  );
}

function AccountBlock({
  section,
  expandedByQuery,
  openingProjectId,
  onOpenProject,
  onRetry,
}: {
  section: AccountSection;
  expandedByQuery: boolean;
  openingProjectId: string | null;
  onOpenProject: (event: MouseEvent<HTMLAnchorElement>, project: KortixProject) => void;
  onRetry: (accountId: string) => void;
}) {
  const t = useTranslations('projectSelector');
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || expandedByQuery;
  const shown = showAll ? section.projects : section.projects.slice(0, COLLAPSED_PROJECT_LIMIT);
  const hidden = section.projects.length - shown.length;

  const meta = [
    t(`role.${section.role}`),
    section.projects.length > 0 ? t('projectCount', { count: section.projects.length }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      className="space-y-3"
      data-testid="selector-account"
      data-account-id={section.accountId}
    >
      <SectionHeading title={section.accountName} meta={meta} />

      {section.state === 'projects' ? (
        <ul className="space-y-2">
          {shown.map((project) => (
            <ProjectRow
              key={project.project_id}
              project={project}
              opening={openingProjectId === project.project_id}
              onOpen={onOpenProject}
            />
          ))}
          {hidden > 0 ||
          (expanded && section.projects.length > COLLAPSED_PROJECT_LIMIT && !expandedByQuery) ? (
            <li>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground w-full"
                onClick={() => setExpanded((value) => !value)}
              >
                {hidden > 0 ? t('showAll', { count: section.projects.length }) : t('showFewer')}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : section.state === 'empty-creatable' ? (
        <Link
          href={newWorkspacePathForAccount(section.accountId)}
          className="group hover:bg-hover focus-visible:ring-ring flex items-center gap-3 rounded-md border border-dashed px-4 py-3 transition-colors outline-none focus-visible:ring-2"
        >
          <span className="text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md border border-dashed">
            <PlusIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="text-foreground block text-sm font-medium">{t('createIn')}</span>
            <span className="text-muted-foreground block text-xs">{t('emptyCreatable')}</span>
          </span>
        </Link>
      ) : section.state === 'empty-member' ? (
        <p
          className="text-muted-foreground rounded-md border border-dashed px-4 py-3 text-xs"
          data-testid="selector-empty-member"
        >
          {t('emptyMember')}
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-4 py-3">
          <p className="text-muted-foreground text-xs">{t('failed')}</p>
          <Button size="sm" variant="outline" onClick={() => onRetry(section.accountId)}>
            {t('retry')}
          </Button>
        </div>
      )}
    </section>
  );
}

function ProjectRow({
  project,
  opening,
  onOpen,
}: {
  project: KortixProject;
  opening: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, project: KortixProject) => void;
}) {
  const t = useTranslations('projectSelector');
  const locale = useLocale();
  const opened = relativeTime(project.last_opened_at, locale);
  return (
    <li>
      <Link
        href={`/projects/${project.project_id}`}
        onClick={(event) => onOpen(event, project)}
        data-testid="selector-project"
        className="group bg-popover hover:bg-hover focus-visible:ring-ring duration-fast flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors outline-none focus-visible:ring-2"
      >
        <EntityAvatar
          label={project.name}
          glyph={project.icon_glyph}
          emoji={project.icon}
          size="md"
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="text-foreground block truncate text-sm font-medium">{project.name}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {opened ? t('openedAgo', { time: opened }) : t('neverOpened')}
          </span>
        </span>
        {opening ? (
          <Loading className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ArrowRightIcon
            className={cn(
              'text-muted-foreground duration-fast size-4 shrink-0 opacity-0 transition-opacity',
              'group-hover:opacity-100 group-focus-visible:opacity-100',
            )}
          />
        )}
      </Link>
    </li>
  );
}

/** The stateful half: reads, Join, open-project bookkeeping, sign-out. */
export function ProjectSelector() {
  const t = useTranslations('projectSelector');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const setSelectedAccountId = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const data = useProjectSelectorData();
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  // Never cleared: `performSignOut` replaces the document.
  const [signingOut, setSigningOut] = useState(false);

  useSignedOutRedirect();

  const createAccount = data.sections.find((section) => section.canCreate);
  const createHref = createAccount ? newWorkspacePathForAccount(createAccount.accountId) : null;

  const join = useMutation({
    mutationFn: (invite: MyAccountInvite) => acceptAccountInvite(invite.invite_id),
    onSuccess: async (_result, invite) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.accounts.scope() }),
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() }),
      ]);
      setSelectedAccountId(invite.account_id);
      const destination = joinDestination(invite);
      // A workspace invite with no project stays here: the joined account now
      // appears in the list below with its own state.
      if (destination) router.push(destination);
    },
    onError: (error: unknown) => {
      errorToast(error instanceof Error ? error.message : t('joinError'));
    },
  });

  return (
    <ProjectSelectorView
      email={user?.email ?? null}
      loading={data.listsLoading || data.invitesQuery.isLoading}
      loadFailed={data.accountsQuery.isError || data.allListsFailed}
      sections={data.sections}
      invites={data.invites}
      createHref={createHref}
      joiningInviteId={join.isPending ? (join.variables?.invite_id ?? null) : null}
      openingProjectId={openingProjectId}
      signingOut={signingOut}
      onJoin={(invite) => join.mutate(invite)}
      onOpenProject={(event, project) => {
        // A modified click opens a new tab; this tab's state must not move.
        if (isModifiedClick(event)) return;
        setOpeningProjectId(project.project_id);
        setSelectedAccountId(project.account_id);
        writeLastProjectId(user?.id, project.project_id);
      }}
      onRetryAccount={data.retryAccount}
      onRetryAll={data.retryAll}
      onLogOut={() => {
        setSigningOut(true);
        void performSignOut();
      }}
    />
  );
}
