'use client';

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { useMyInvites } from '@/hooks/account/use-my-invites';
import { useTranslations } from '@/i18n/use-translations';
import { NewWorkspacePage } from '@/features/workspace/new/new-workspace-page';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { acceptAccountInvite, type MyAccountInvite } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Suspense, useState } from 'react';

/**
 * `/projects/start` with nothing to open: the chooser.
 *
 * Replaces the automatic "My First Project". That auto-create ran before the
 * user could see anything, so an invitee who signed up without the email link
 * landed in a fresh personal project with no sign of the invite. Now the door
 * shows what the user can act on, Slack-style:
 *
 *  - `invites`       — pending invites for the caller's email, each with Join.
 *                      Creating is the secondary path underneath.
 *  - `empty`         — no invites, may create: one create action, and a line
 *                      naming the email that invites reach.
 *  - `no-permission` — no invites, member without PROJECT_CREATE: no create
 *                      control (it would only 403). Flow-08 contract.
 *
 * `/projects` redirects to this route, so nothing here links to it.
 */
export type ChooserMode = 'invites' | 'empty' | 'no-permission';

export function chooserMode(input: { inviteCount: number; canCreate: boolean }): ChooserMode {
  if (input.inviteCount > 0) return 'invites';
  return input.canCreate ? 'empty' : 'no-permission';
}

/**
 * Where Join goes. A project invite opens the first invited project. A plain
 * workspace invite has no project yet, so the caller re-runs the landing
 * resolver against the refreshed account list.
 */
export function joinDestination(invite: MyAccountInvite): string | null {
  const first = invite.projects[0];
  return first ? `/projects/${first.project_id}` : null;
}

export interface ProjectChooserViewProps {
  email: string | null;
  invites: MyAccountInvite[];
  invitesLoading: boolean;
  canCreate: boolean;
  /** The invite whose Join is in flight; every Join is disabled meanwhile. */
  joiningInviteId: string | null;
  onJoin: (invite: MyAccountInvite) => void;
  onLogOut: () => void;
  signingOut: boolean;
}

/**
 * Props-only half, so every state renders under `renderToStaticMarkup`.
 *
 * Laid out exactly like `/new` (`new-workspace-page.tsx`): the same centered
 * `max-w-md` column, top-right ghost Log out, `text-2xl` title with a muted
 * line under it, field-well rows (`Input`'s own `border bg-input rounded-md`)
 * under a `Label`, and a full-width `lg` primary action. Both pages are the
 * two halves of one first-run flow, so they must read as one surface.
 */
export function ProjectChooserView({
  email,
  invites,
  invitesLoading,
  canCreate,
  joiningInviteId,
  onJoin,
  onLogOut,
  signingOut,
}: ProjectChooserViewProps) {
  const t = useTranslations('projectChooser');
  const tNew = useTranslations('newWorkspace');
  const mode = chooserMode({ inviteCount: invites.length, canCreate });
  const recipient = email ?? '';

  // `empty` never reaches this view: `ProjectChooser` renders the `/new` form
  // itself for it.
  const title = mode === 'invites' ? t('invitesTitle') : t('noPermissionTitle');
  const description =
    mode === 'invites' ? t('invitesDescription') : t('noPermissionBody', { email: recipient });

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="kx-desktop-band-row absolute inset-x-0 top-3 z-10 flex items-center justify-end gap-3 px-4 sm:top-4 sm:px-6">
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

      {/* Blank while the invite list loads — no spinner. It resolves in one
          round trip, and a spinner here was a third loader on one navigation. */}
      {invitesLoading ? null : (
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2 text-center">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          </header>

          {mode === 'invites' ? (
            <div className="flex flex-col space-y-3">
              <Label>{t('invitations')}</Label>
              <ul className="space-y-2">
                {invites.map((invite) => (
                  <InviteRow
                    key={invite.invite_id}
                    invite={invite}
                    joining={joiningInviteId === invite.invite_id}
                    disabled={joiningInviteId !== null}
                    onJoin={onJoin}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {mode === 'invites' && canCreate ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground self-center"
            >
              <Link href="/new">{t('createProjectInstead')}</Link>
            </Button>
          ) : null}

        </div>
      )}
    </main>
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
  const t = useTranslations('projectChooser');
  const workspace = invite.account_name ?? t('unnamedWorkspace');
  // A project invite leads with the project — that is where Join lands. A
  // workspace invite leads with the workspace.
  const hasProjects = invite.projects.length > 0;
  const title = hasProjects ? invite.projects.map((p) => p.name).join(', ') : workspace;

  return (
    <li className="border-border bg-input flex items-center gap-3 rounded-md border px-3 py-2.5">
      <EntityAvatar label={title} size="md" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground truncate text-sm font-medium">{title}</p>
        {/* Only the long inviter email truncates; the workspace name stays whole. */}
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
      <Button size="sm" disabled={disabled} onClick={() => onJoin(invite)} className="shrink-0 gap-1.5">
        {joining ? <Loading className="size-3.5 shrink-0" /> : null}
        {t('join')}
      </Button>
    </li>
  );
}

/**
 * The stateful half: reads the invites, runs Join, and hands the destination
 * back to the page. `onJoined(null)` means "no project to open directly" —
 * the page re-runs its resolver against the refreshed account list.
 */
export function ProjectChooser({
  canCreate,
  onJoined,
}: {
  canCreate: boolean;
  onJoined: (result: { accountId: string; destination: string | null }) => void;
}) {
  const t = useTranslations('projectChooser');
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const invitesQuery = useMyInvites();
  const invites = invitesQuery.data ?? [];
  // Never cleared: `performSignOut` replaces the document.
  const [signingOut, setSigningOut] = useState(false);

  const join = useMutation({
    mutationFn: (invite: MyAccountInvite) => acceptAccountInvite(invite.invite_id),
    onSuccess: async (_result, invite) => {
      // One prefix reaches the account list AND this invite list
      // (`qk.accounts.myInvites` sits under `scope()`), plus every project list.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.accounts.scope() }),
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() }),
      ]);
      onJoined({ accountId: invite.account_id, destination: joinDestination(invite) });
    },
    onError: (error: unknown) => {
      errorToast(error instanceof Error ? error.message : t('joinError'));
    },
  });

  // Nothing to join and allowed to create: the create form IS the empty state.
  // A page whose only control is a link to `/new` is one click too many.
  if (!invitesQuery.isLoading && chooserMode({ inviteCount: invites.length, canCreate }) === 'empty') {
    return (
      <Suspense fallback={null}>
        <NewWorkspacePage showBack={false} />
      </Suspense>
    );
  }

  return (
    <ProjectChooserView
      email={user?.email ?? null}
      invites={invites}
      // A failed invite read degrades to "no invites" rather than blocking the
      // create path — the switcher shows the same list once it loads.
      invitesLoading={invitesQuery.isLoading}
      canCreate={canCreate}
      joiningInviteId={join.isPending ? (join.variables?.invite_id ?? null) : null}
      onJoin={(invite) => join.mutate(invite)}
      // `performSignOut` owns the whole exit and ends on a document load.
      onLogOut={() => {
        setSigningOut(true);
        void performSignOut();
      }}
      signingOut={signingOut}
    />
  );
}
