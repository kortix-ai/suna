'use client';

import { useTranslations } from 'next-intl';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { AcpSessionChat } from '@/features/session/acp-session-chat';
import { SessionLayout } from '@/features/session/session-layout';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';
import { useAccountState } from '@/hooks/billing';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { isBillingEnabled } from '@/lib/config';
import { sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { clearSessionFresh, isSessionFresh } from '@kortix/sdk/fresh-sessions';
import { setActiveInstanceCookie } from '@kortix/sdk/instance-routes';
import { getProjectDetail } from '@kortix/sdk/projects-client';
import { readStartStash, useSession } from '@kortix/sdk/react';
import { projectAcpChatItems } from '@kortix/sdk';

/**
 * /projects/[id]/sessions/[sessionId] — project-scoped session view.
 *
 * The entire runtime lifecycle (POST /start, the sandbox switch, the SSE stream,
 * readiness seeding, and the ACP session) is owned by the SDK's
 * `useSession` hook — the page no longer hand-rolls the 7-step mount. The page
 * keeps its rich shell: the billing gate, the instant-shell/loader crossfade, the
 * fresh-session + pending-prompt hand-off, and the restart/error cards.
 *
 * Readiness is server-truth (`/start` `stage==='ready'`, seeded by useSession into
 * the connection store). The local `useSandboxConnection` poller is still mounted
 * — purely for MID-SESSION reconnect detection (the box dropping after it was
 * healthy), which drives the reconnect/offline UI. The URL stays at
 * `/projects/<id>/sessions/<sessionId>` the whole time.
 */
export default function ProjectSessionPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();
  const { user, isLoading: authLoading } = useAuth();

  // Billing gate. An account that cannot run should not start a session — the
  // backend would never provision a sandbox, so polling for one spins forever.
  // Scope to the account that OWNS this project (team account), not the viewer's.
  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => {
      if (!projectId) throw new Error('Missing project id');
      return getProjectDetail(projectId);
    },
    enabled: !!projectId,
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState, isLoading: accountStateLoading } = useAccountState({
    accountId: projectAccountId,
  });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const accountLoaded = !!accountState;
  const billingGatePending =
    isBillingEnabled() && !!projectAccountId && (accountStateLoading || !accountLoaded);
  const noPlan = isBillingEnabled() && accountLoaded && !accountState.credits?.can_run;

  // ONE hook owns the runtime: POST /start (idempotent provision/resume + the
  // server-resolved ACP runtime), the sandbox switch, the SSE stream, readiness
  // seeding (no client health poll), and the canonical id. Gated on the billing
  // check so a no-plan account never spins on a sandbox that won't provision.
  // replayStartStash:false — the web has its own pending-prompt hand-off (below).
  const session = useSession(projectId, sessionId, {
    enabled: !!user && !billingGatePending && !noPlan,
    replayStartStash: false,
    chatEngine: false,
  });
  const acpItems = useMemo(() => projectAcpChatItems(session.acp.envelopes), [session.acp.envelopes]);
  const sandbox = session.sandbox;
  const startStage = session.stage ?? 'provisioning';

  // Belt-and-suspenders: clear the legacy active-instance cookie once on mount for
  // this route so no later navigation can be hijacked onto a stale sandbox.
  useEffect(() => {
    setActiveInstanceCookie(null);
  }, []);

  useEffect(() => {
    if (session.switched && sandbox) sessionMark(sandbox.session_id, 'server-switched');
  }, [session.switched, sandbox]);

  // The moment we know there's no plan, pop the one Team plan modal.
  const billingGatedRef = useRef(false);
  useEffect(() => {
    if (!noPlan || billingGatedRef.current) return;
    billingGatedRef.current = true;
    openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
  }, [noPlan, openUpgradeDialog, projectAccountId]);

  // ── Crossfade: the instant shell fades out as the real chat fades in ──────
  // A fully-interactive shell (welcome wallpaper + live input) renders at a SINGLE
  // stable tree position for the whole pre-ready lifecycle, so it never remounts.
  const [chatReady, setChatReady] = useState(false);
  const [loaderMounted, setLoaderMounted] = useState(true);
  const [shellSubmitted, setShellSubmitted] = useState(false);
  const freshRef = useRef<boolean>(false);
  const lifecycleForRef = useRef<string | null>(null);
  if (lifecycleForRef.current !== sessionId) {
    lifecycleForRef.current = sessionId;
    if (chatReady) setChatReady(false);
    if (!loaderMounted) setLoaderMounted(true);
    let fresh = false;
    let pending = false;
    if (typeof window !== 'undefined') {
      // Was two raw legacy-key checks — now that every producer stashes
      // canonically under the route id (see the `migrateStash` call below),
      // `readStartStash` is the one check that still sees a stash from any of
      // them (canonical or legacy shape) without knowing which key it lives
      // under.
      pending = !!readStartStash(sessionId)?.prompt;
      fresh = pending || isSessionFresh(sessionId);
    }
    freshRef.current = fresh;
    setShellSubmitted(pending);
  }
  const isFresh = freshRef.current;
  useEffect(() => {
    if (chatReady) clearSessionFresh(sessionId);
  }, [chatReady, sessionId]);

  // Terminal/gated states fully REPLACE the content (no chat to fade to).
  const gated = !authLoading && !!user && noPlan;
  const fatal =
    !authLoading &&
    !!user &&
    !!sandbox &&
    (sandbox.status === 'error' || sandbox.status === 'stopped');
  // The chat subtree mounts once useSession reports the runtime is switched in.
  const canMountChat = session.switched;
  // For a fresh session, hold the real chat until the user actually sends their
  // first message — the instant shell is the typing surface until then.
  const mountChat = canMountChat && (!isFresh || shellSubmitted);

  const sandboxLabel = sandbox ? `session ${sandbox.sandbox_id.slice(0, 8)}` : undefined;
  const inner = (() => {
    if (gated) {
      return (
        <InlineSessionError
          title={tI18nHardcoded.raw(
            'autoAppAppProjectsIdSessionsSessionIdPageJsxAttrTitlebf9bba8c',
          )}
          message={tI18nHardcoded.raw(
            'autoAppAppProjectsIdSessionsSessionIdPageJsxAttrMessage93bc2779',
          )}
          action={
            <Button
              onClick={() =>
                openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId })
              }
            >
              {tI18nHardcoded.raw(
                'autoAppAppProjectsIdSessionsSessionIdPageJsxTextSubscribe40f5b8e1',
              )}
            </Button>
          }
        />
      );
    }

    if (session.startError) {
      const sessionMissing = session.startError.status === 404;
      return (
        <InlineSessionError
          title="Couldn't start session"
          message={
            sessionMissing
              ? 'This session is no longer available, or you do not have access to it.'
              : session.startError.message
          }
        />
      );
    }

    if (fatal) {
      const meta = (sandbox?.metadata as Record<string, unknown>) ?? {};
      return sandbox?.status === 'error' ? (
        <InlineSessionError
          title={`Couldn't start ${sandboxLabel ?? 'session'}`}
          message={
            (meta.provisioningError as string) ||
            (meta.errorMessage as string) ||
            'Something went wrong while provisioning this session.'
          }
        />
      ) : (
        <InlineSessionError
          title={`${sandboxLabel ?? 'session'} is stopped`}
          message={tI18nHardcoded.raw(
            'appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen',
          )}
        />
      );
    }

    // Dual-layer: the real chat mounts under the instant shell (fresh sessions) or
    // the staged loader (resumes) and crossfades in once it's ready. useSession
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {canMountChat && (
          <div
            className={cn(
              'absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-300 ease-out',
              chatReady ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <ProjectSessionRuntimeConnection>
              {mountChat && (
                <AcpSessionChat
                  acp={session.acp!}
                  onReady={() => setChatReady(true)}
                />
              )}
            </ProjectSessionRuntimeConnection>
          </div>
        )}

        {loaderMounted && (
          <div
            onTransitionEnd={() => {
              if (chatReady) setLoaderMounted(false);
            }}
            className={cn(
              'absolute inset-0 flex flex-col transition-opacity duration-300 ease-out',
              chatReady ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            {isFresh ? (
              <InstantSessionShell
                projectId={projectId}
                sessionId={sessionId}
                stage={authLoading || !user ? 'provisioning' : startStage}
                onSubmit={() => setShellSubmitted(true)}
              />
            ) : (
              <SessionStartingLoader
                stage={authLoading || !user ? 'provisioning' : startStage}
                projectId={projectId}
                sessionId={sessionId}
              />
            )}
          </div>
        )}
      </div>
    );
  })();

  return (
    <ProjectShell projectId={projectId}>
      <SessionLayout
        sessionId={session.runtimeId ?? sessionId}
        projectId={projectId}
        projectSessionId={sessionId}
        bootStage={session.phase === 'ready' ? null : startStage}
        acpItems={acpItems}
      >
        <SandboxLoadingBoundary>{inner}</SandboxLoadingBoundary>
      </SessionLayout>
    </ProjectShell>
  );
}

function ProjectSessionRuntimeConnection({ children }: { children: ReactNode }) {
  // MID-SESSION reconnect detection only. Initial readiness is server-truth (seeded
  // by useSession from /start); this poller keeps the SDK-unified connection store's
  // status fresh so the reconnect/offline UI fires if the box drops after boot.
  useSandboxConnection();
  return <>{children}</>;
}

/* ─── Inline error card (used inside the project shell) ────────────────── */

function InlineSessionError({
  title,
  message,
  detail,
  action,
}: {
  title: string;
  message: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h2 className="text-foreground/90 text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground/70 text-xs leading-relaxed">{message}</p>
        {detail ? (
          <p className="border-border/60 bg-muted/40 text-muted-foreground max-w-full rounded-2xl border px-2 py-1 font-mono text-xs leading-relaxed">
            {detail}
          </p>
        ) : null}
        {action}
      </div>
    </div>
  );
}
