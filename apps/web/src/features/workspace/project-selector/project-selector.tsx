'use client';

import { acceptAccountInviteAndLand, type MyAccountInvite } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { ArrowRightIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type MouseEvent } from 'react';

import { Button } from '@kortix/ui/button';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { InlineMeta } from '@kortix/ui/inline-meta';
import { Input } from '@kortix/ui/input';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { errorToast } from '@kortix/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { AccountTopBar } from '@/features/workspace/account-top-bar';
import { useTranslations } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { isAccountCreationRestricted } from '@/lib/config';
import { isModifiedClick } from '@kortix/ui/internal/lib/navigation/modified-click';
import { writeLastProjectId } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { cn } from '@kortix/ui';
import { useAdminRole } from '@kortix/ui/internal/hooks/admin/use-admin-role';
import { useCurrentAccountStore } from '@kortix/ui/internal/stores/current-account-store';

import {
  SEARCH_THRESHOLD,
  canCreateWorkspace,
  filterWorkspaceRows,
  inviteLandingPath,
  type WorkspaceRow,
} from '@kortix/ui/workspace/project-selector/project-selector-model';
import { useProjectSelectorData } from './use-project-selector-data';

/**
 * `/projects` — create a workspace or join one, Slack-style.
 *
 * One column, three states (`project-selector-model.ts`):
 *
 *  - 0 workspaces, 0 invites — "Create a workspace", one primary button, and
 *    one quiet line for the person who expected an invite;
 *  - invites pending        — the invitations first, each with Join, then
 *    the create action;
 *  - 1+ workspaces          — one flat list, one row per workspace, search
 *    at 8+ rows, and one "Create workspace" action under it.
 *
 * No account headings: a workspace is one account and its one project. Self
 * host with account creation restricted shows no create action, only
 * "Ask an admin to invite {email}" (`canCreateWorkspace`).
 */
export interface ProjectSelectorViewProps {
  connectComputer?: boolean;
  email: string | null;
  name?: string | null;
  loading: boolean;
  loadFailed: boolean;
  /** Some account's project list failed: the list may be missing rows. */
  partialFailure?: boolean;
  workspaces: WorkspaceRow[];
  invites: MyAccountInvite[];
  /** `/new`, or null when this caller may not create a workspace. */
  createHref: string | null;
  joiningInviteId: string | null;
  openingProjectId: string | null;
  signingOut: boolean;
  onJoin: (invite: MyAccountInvite) => void;
  onOpenProject: (event: MouseEvent<HTMLAnchorElement>, row: WorkspaceRow) => void;
  onRetryAll: () => void;
  onLogOut: () => void;
}

export function ProjectSelectorView(props: ProjectSelectorViewProps) {
  const t = useTranslations('workspaces.chooser');
  const { email, loading, loadFailed, workspaces, invites } = props;
  const createHref =
    props.createHref && props.connectComputer ? `${props.createHref}?connect=computer` : props.createHref;
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterWorkspaceRows(workspaces, query), [workspaces, query]);
  const trimmed = query.trim();

  const hasWorkspaces = workspaces.length > 0;
  const hasInvites = invites.length > 0;
  const restricted = !createHref && !hasWorkspaces && !hasInvites;

  const [title, description] = restricted
    ? [t('restrictedTitle'), t('restrictedBody', { email: email ?? '' })]
    : hasWorkspaces
      ? [t('listTitle'), t('listBody')]
      : hasInvites
        ? [t('invitesTitle'), t('invitesBody')]
        : [t('createTitle'), t('createBody')];

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col px-6 py-20">
      <AccountTopBar email={email} name={props.name} signingOut={props.signingOut} onLogOut={props.onLogOut} />

      {/* `my-auto` centers the block in the viewport while it fits, and lets
          it start at the top and scroll once the list is taller. Blank while
          the reads resolve (one round trip): a centered block that changes
          height would slide the header down under the eye. */}
      {loading ? null : (
        <div className="my-auto w-full">
          <header className="flex flex-col items-center gap-2 text-center">
            <KortixLogo size={28} variant="icon" className="mb-3" />
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h1>
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
              {hasInvites ? (
                <section className="space-y-3" data-testid="selector-invites">
                  <SectionHeading title={t('invitations')} meta={email ? t('sentTo', { email }) : null} />
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

              {hasWorkspaces ? (
                <section className="space-y-3" data-testid="selector-workspaces">
                  {hasInvites ? <SectionHeading title={t('workspacesHeading')} meta={null} /> : null}
                  {workspaces.length > SEARCH_THRESHOLD ? (
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
                  {trimmed && visible.length === 0 ? (
                    <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                      {t('noMatches', { query: trimmed })}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {visible.map((row) => (
                        <WorkspaceRowLink
                          key={row.workspaceId}
                          row={row}
                          connectComputer={props.connectComputer}
                          opening={props.openingProjectId === row.workspaceId}
                          onOpen={props.onOpenProject}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {props.partialFailure ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-4 py-3">
                  <p className="text-muted-foreground text-xs">{t('partialError')}</p>
                  <Button size="sm" variant="outline" onClick={props.onRetryAll}>
                    {t('retry')}
                  </Button>
                </div>
              ) : null}

              {createHref ? (
                <div className="space-y-3">
                  <Button
                    asChild
                    size="lg"
                    variant={hasWorkspaces || hasInvites ? 'outline' : 'default'}
                    className="w-full gap-1.5"
                  >
                    <Link href={createHref} prefetch data-testid="selector-create">
                      <PlusIcon className="size-4 shrink-0" />
                      {t('createAction')}
                    </Link>
                  </Button>
                  {!hasWorkspaces && !hasInvites ? (
                    <p className="text-muted-foreground text-center text-xs text-balance">
                      {t('invitedHint', { email: email ?? '' })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </main>
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

const KNOWN_ROLES = new Set(['owner', 'admin', 'member']);

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
  const t = useTranslations('workspaces.chooser');
  // A workspace is the account and its project: an invite that names the
  // project shows the project's name, the name the workspace shows once joined.
  const title =
    invite.projects.length > 0
      ? invite.projects.map((p) => p.name).join(', ')
      : (invite.account_name ?? t('unnamedWorkspace'));
  const role = KNOWN_ROLES.has(invite.initial_role) ? t(`role.${invite.initial_role}`) : null;

  return (
    <li className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3" data-testid="selector-invite">
      <EntityAvatar label={title} size="lg" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground truncate text-sm font-medium">{title}</p>
        <InlineMeta>
          {invite.inviter_email ? t('invitedBy', { email: invite.inviter_email }) : null}
          {role}
        </InlineMeta>
      </div>
      <Button
        size="sm"
        disabled={disabled}
        aria-busy={joining || undefined}
        onClick={() => onJoin(invite)}
        className="shrink-0 gap-1.5"
      >
        {joining ? <Loading className="size-3.5 shrink-0" /> : null}
        {t('join')}
      </Button>
    </li>
  );
}

function WorkspaceRowLink({
  row,
  connectComputer,
  opening,
  onOpen,
}: {
  row: WorkspaceRow;
  connectComputer?: boolean;
  opening: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, row: WorkspaceRow) => void;
}) {
  const t = useTranslations('workspaces.chooser');
  const { project } = row;
  return (
    <li>
      <Link
        href={`/projects/${project.project_id}${connectComputer ? '/settings/computer' : ''}`}
        onClick={(event) => onOpen(event, row)}
        data-testid="selector-project"
        className="group bg-popover hover:bg-hover focus-visible:ring-ring duration-fast flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors outline-none focus-visible:ring-2"
      >
        <EntityAvatar label={project.name} glyph={project.icon_glyph} emoji={project.icon} size="md" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="text-foreground block truncate text-sm font-medium">{project.name}</span>
          <span className="text-muted-foreground block truncate text-xs">{t(`role.${row.role}`)}</span>
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

/** The stateful half: reads, Join, open-workspace bookkeeping, sign-out. */
export function ProjectSelector({ connectComputer }: { connectComputer?: boolean } = {}) {
  const t = useTranslations('workspaces.chooser');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const setSelectedAccountId = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const data = useProjectSelectorData();
  const { data: adminRole } = useAdminRole();
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  // Never cleared: `performSignOut` replaces the document.
  const [signingOut, setSigningOut] = useState(false);

  useSignedOutRedirect();

  const createHref = canCreateWorkspace({
    restricted: isAccountCreationRestricted(),
    isPlatformAdmin: Boolean(adminRole?.isAdmin),
    reusableAccount: data.reusableAccount,
  })
    ? '/new'
    : null;

  const join = useMutation({
    mutationFn: (invite: MyAccountInvite) => acceptAccountInviteAndLand(invite.invite_id, invite),
    onSuccess: async ({ landing }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.accounts.scope() }),
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() }),
      ]);
      setSelectedAccountId(landing.accountId);
      // Joining a workspace opens it. The door resolves an account landing to
      // its project (`inviteLandingPath`).
      router.push(inviteLandingPath(landing));
    },
    onError: () => {
      errorToast(t('joinError'));
    },
  });

  return (
    <ProjectSelectorView
      connectComputer={connectComputer}
      email={user?.email ?? null}
      name={user?.user_metadata?.name}
      loading={data.listsLoading || data.invitesQuery.isLoading}
      loadFailed={data.accountsQuery.isError || data.allListsFailed}
      partialFailure={data.failedAccountIds.length > 0}
      workspaces={data.workspaces}
      invites={data.invites}
      createHref={createHref}
      joiningInviteId={join.isPending ? (join.variables?.invite_id ?? null) : null}
      openingProjectId={openingProjectId}
      signingOut={signingOut}
      onJoin={(invite) => join.mutate(invite)}
      onOpenProject={(event, row) => {
        // A modified click opens a new tab; this tab's state must not move.
        if (isModifiedClick(event)) return;
        setOpeningProjectId(row.workspaceId);
        setSelectedAccountId(row.accountId);
        writeLastProjectId(user?.id, row.workspaceId);
      }}
      onRetryAll={data.retryAll}
      onLogOut={() => {
        setSigningOut(true);
        void performSignOut();
      }}
    />
  );
}
