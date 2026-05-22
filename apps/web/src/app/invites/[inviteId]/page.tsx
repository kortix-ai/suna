'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Clock, Loader2 } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/user-avatar';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@/lib/utils';
import {
  acceptAccountInvite,
  declineAccountInvite,
  describeAccountInvite,
  type AccountInviteDescribe,
} from '@/lib/projects-client';

type UnifiedInvite = { kind: 'account'; invite: AccountInviteDescribe };

async function getUnifiedInvite(inviteId: string): Promise<UnifiedInvite> {
  return { kind: 'account', invite: await describeAccountInvite(inviteId) };
}

export default function InvitePage() {
  const { inviteId } = useParams<{ inviteId: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  // Not logged in → send through /auth with a return-to so they come back
  // here after sign-in/up. New users can have account/workspace invites
  // auto-claimed on first authenticated account resolution, so this page also
  // handles already-accepted invite rows by routing into the right surface.
  useEffect(() => {
    if (!authLoading && !user) {
      const returnUrl = encodeURIComponent(`/invites/${inviteId}`);
      router.replace(`/auth?returnUrl=${returnUrl}`);
    }
  }, [authLoading, user, inviteId, router]);

  const inviteQuery = useQuery({
    queryKey: ['invite', inviteId],
    queryFn: () => getUnifiedInvite(inviteId!),
    enabled: !!user && !!inviteId,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const current = inviteQuery.data;
      if (!current) throw new Error('Invite is still loading');
      return { kind: 'account' as const, data: await acceptAccountInvite(inviteId!) };
    },
    onSuccess: (result) => {
      router.replace(`/accounts/${result.data.account_id}`);
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      const current = inviteQuery.data;
      if (!current) throw new Error('Invite is still loading');
      await declineAccountInvite(inviteId!);
      return { kind: 'account' as const };
    },
    onSuccess: () => {
      router.replace('/accounts');
    },
  });

  useEffect(() => {
    const item = inviteQuery.data;
    const inv = item?.invite;
    // Only auto-redirect the actual recipient. Strangers with a link hit the
    // "wrong account" state instead.
    if (!item || !inv?.email_matches_caller || !inv.accepted_at) return;
    router.replace(`/accounts/${item.invite.account_id}`);
  }, [inviteQuery.data, router]);

  if (authLoading || !user || inviteQuery.isLoading) {
    return (
      <BrandSurface>
        <div className="flex items-center gap-2.5 text-foreground/40 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading invite…
        </div>
      </BrandSurface>
    );
  }

  if (inviteQuery.error) {
    return (
      <BrandSurface>
        <InviteCard kicker="Invite">
          <StateHeading>Invite not found</StateHeading>
          <StateBody>
            {inviteQuery.error instanceof Error
              ? inviteQuery.error.message
              : 'This invite link is invalid or has been revoked.'}
          </StateBody>
          <GhostAction onClick={() => router.replace('/projects')}>
            Back to projects
          </GhostAction>
        </InviteCard>
      </BrandSurface>
    );
  }

  const item = inviteQuery.data;
  if (!item) return null;
  const invite = item.invite;

  // Wrong-account check first: the server redacts identifying fields in this
  // case, and checking expiry before this would leak "this invite exists and
  // expired" to someone who shouldn't know it exists at all.
  if (!invite.email_matches_caller) {
    return (
      <BrandSurface>
        <InviteCard kicker="Wrong account">
          <StateHeading>Switch accounts</StateHeading>
          <StateBody>
            This invite is addressed to a different account. You're signed in
            as <span className="text-foreground/80 font-medium">{user.email}</span>.
          </StateBody>
          <p className="text-[12px] text-foreground/30 mt-4">
            Sign out and sign back in with the address that received the invite.
          </p>
          <GhostAction onClick={() => router.replace('/projects')}>
            Back to projects
          </GhostAction>
        </InviteCard>
      </BrandSurface>
    );
  }

  if (invite.expired) {
    return (
      <BrandSurface>
        <InviteCard kicker="Invite">
          <StateHeading>Invite expired</StateHeading>
          <StateBody>
            Expired <span className="text-foreground/60">{formatWhen(invite.expires_at)}</span>. Ask the person who invited you to send a new one.
          </StateBody>
          <GhostAction onClick={() => router.replace('/projects')}>
            Back to projects
          </GhostAction>
        </InviteCard>
      </BrandSurface>
    );
  }

  const acceptPending = acceptMutation.isPending;
  const declinePending = declineMutation.isPending;
  const anyPending = acceptPending || declinePending;
  const errorMessage =
    (acceptMutation.error instanceof Error && acceptMutation.error.message) ||
    (declineMutation.error instanceof Error && declineMutation.error.message) ||
    null;
  const targetName = item.invite.account_name || 'Account';
  const inviterEmail = invite.inviter_email;
  const targetLabel = 'Team account';
  const roleLabel = item.invite.initial_role === 'admin'
    ? 'an admin'
    : 'a member';

  return (
    <BrandSurface>
      <InviteCard kicker="Invitation">
        {inviterEmail ? (
          <div className="flex items-center gap-3">
            <UserAvatar email={inviterEmail} size="lg" />
            <div className="min-w-0">
              <div className="text-foreground/85 truncate text-[14px] font-medium">
                {inviterEmail}
              </div>
              <div className="text-foreground/40 mt-0.5 text-[12px]">
                invited you to join a team
              </div>
            </div>
          </div>
        ) : (
          <div className="text-foreground/50 text-[14px] leading-relaxed">
            You have been invited to join a team.
          </div>
        )}

        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-foreground/[0.08] bg-foreground/[0.03] px-4 py-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.05] text-foreground/60">
            <KortixLogo size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-foreground/85 truncate text-[14px] font-medium">
              {targetName}
            </div>
            <div className="text-foreground/40 mt-0.5 flex items-center gap-1 text-[11px]">
              <Clock className="size-3" />
              {targetLabel} · expires {formatWhen(invite.expires_at)}
            </div>
          </div>
        </div>

        <p className="text-foreground/35 mt-4 text-[11px] leading-relaxed">
          {`You'll join this account as ${roleLabel} and see projects the owner gives you access to.`}
        </p>

        {errorMessage ? (
          <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/[0.08] px-3.5 py-2.5 text-[12px] text-red-300">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={() => declineMutation.mutate()}
            disabled={anyPending}
            className={cn(
              'flex-1 h-10 rounded-xl text-[13px] font-medium transition-colors',
              'bg-foreground/[0.04] hover:bg-foreground/[0.08] border border-foreground/[0.08]',
              'text-foreground/60 hover:text-foreground/80',
              'disabled:opacity-40 disabled:pointer-events-none',
            )}
          >
            {declinePending ? (
              <Loader2 className="h-4 w-4 animate-spin mx-auto" />
            ) : (
              'Decline'
            )}
          </button>
          <button
            type="button"
            onClick={() => acceptMutation.mutate()}
            disabled={anyPending}
            className={cn(
              'flex-1 h-10 rounded-xl text-[13px] font-medium transition-colors',
              'bg-foreground text-background hover:bg-foreground/90',
              'disabled:opacity-40 disabled:pointer-events-none',
            )}
          >
            {acceptPending ? (
              <Loader2 className="h-4 w-4 animate-spin mx-auto" />
            ) : (
              'Accept'
            )}
          </button>
        </div>
      </InviteCard>
    </BrandSurface>
  );
}

// ─── Brand primitives ────────────────────────────────────────────────────────

function BrandSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 overflow-hidden">
      <WallpaperBackground wallpaperId="brandmark" />
      <div className="absolute inset-0 bg-background/20 backdrop-blur-[2px]" />
      <div className="relative z-10 flex h-full items-center justify-center px-4">
        {children}
      </div>
    </div>
  );
}

function InviteCard({
  children,
  kicker,
}: {
  children: React.ReactNode;
  kicker: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-[380px]"
    >
      <div className="flex flex-col items-center gap-5">
        <KortixLogo size={26} />
        <div className="w-full bg-background/80 dark:bg-background/75 backdrop-blur-2xl border border-foreground/[0.06] rounded-[20px] px-7 py-7">
          <p className="text-[11px] text-foreground/30 tracking-[0.2em] uppercase mb-5">
            {kicker}
          </p>
          {children}
        </div>
      </div>
    </motion.div>
  );
}

function StateHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-[28px] font-extralight tracking-tight text-foreground/85 leading-none">
      {children}
    </h1>
  );
}

function StateBody({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[14px] text-foreground/50 leading-relaxed">{children}</p>
  );
}

function GhostAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      className="mt-6 h-10 px-4 rounded-xl text-[13px] text-foreground/60 hover:text-foreground/90 hover:bg-foreground/[0.05]"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((d.getTime() - now.getTime()) / msPerDay);
  if (diffDays < -1) return `on ${d.toLocaleDateString()}`;
  if (diffDays === -1) return 'yesterday';
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 14) return `in ${diffDays} days`;
  return d.toLocaleDateString();
}
