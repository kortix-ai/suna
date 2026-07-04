'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
import { SessionChat } from '@/features/session/session-chat';
import { SessionLayout } from '@/features/session/session-layout';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';
import { useAccountState } from '@/hooks/billing';
import {
  clearOpencodeEnsureGuard,
  useCanonicalOpenCodeSession,
} from '@/hooks/opencode/use-canonical-opencode-session';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { isBillingEnabled } from '@/lib/config';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { clearSessionFresh, isSessionFresh } from '@kortix/sdk/fresh-sessions';
import { setActiveInstanceCookie } from '@kortix/sdk/instance-routes';
import { formatOpenCodeRuntimeError } from '@kortix/sdk/opencode-errors';
import {
  getProjectDetail,
  restartProjectSession,
  sessionStartKey,
} from '@kortix/sdk/projects-client';
import { useSession } from '@kortix/sdk/react';

/**
 * /projects/[id]/sessions/[sessionId] — project-scoped session view.
 *
 * The entire runtime lifecycle (POST /start, the sandbox switch, the SSE stream,
 * readiness seeding, and the canonical OpenCode pin) is owned by the SDK's
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
  // server-resolved OpenCode pin), the sandbox switch, the SSE stream, readiness
  // seeding (no client health poll), and the canonical id. Gated on the billing
  // check so a no-plan account never spins on a sandbox that won't provision.
  // replayStartStash:false — the web has its own pending-prompt hand-off (below).
  const session = useSession(projectId, sessionId, {
    enabled: !!user && !billingGatePending && !noPlan,
    replayStartStash: false,
  });
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
      pending =
        !!sessionStorage.getItem(`opencode_pending_prompt:${sessionId}`) ||
        !!sessionStorage.getItem(`project_pending_prompt:${sessionId}`);
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
                <ActiveSessionChat
                  projectId={projectId}
                  sessionId={sessionId}
                  pinFromStart={session.opencodeSessionId}
                  onChatReady={() => setChatReady(true)}
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
      <SandboxLoadingBoundary>{inner}</SandboxLoadingBoundary>
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

/**
 * Renders SessionLayout + SessionChat against this project session's sandbox.
 * useSession (at the page level) already resolved the canonical pin; this still
 * calls useCanonicalOpenCodeSession to surface the live OpenCode session LIST for
 * ?oc deep-links + sub-session rendering (React Query dedupes the shared queries).
 */
function ActiveSessionChat({
  projectId,
  sessionId,
  pinFromStart,
  onChatReady,
}: {
  projectId: string;
  sessionId: string;
  pinFromStart: string | null;
  onChatReady?: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const runtimeReady = useSandboxConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  const runtimeBootError = useSandboxConnectionStore((s) => s.runtimeError);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  const {
    rootSessionId,
    sessions: opencodeSessions,
    isLoading: sessionsLoading,
    listed: sessionsListed,
    error: runtimeError,
  } = useCanonicalOpenCodeSession({ projectId, sessionId, pinFromStart });

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId, sessionId),
    onMutate: () => {
      queryClient.setQueryData(sessionStartKey(projectId, sessionId), {
        stage: 'provisioning',
        retriable: true,
        sandbox: null,
        opencode_session_id: null,
        reason: 'restart_requested',
      });
    },
    onSuccess: () => {
      clearOpencodeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
      queryClient.invalidateQueries({
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
      });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
  });

  const selectedOpenCodeSessionId = searchParams.get('oc');
  const selectedSession = selectedOpenCodeSessionId
    ? opencodeSessions.find((session) => session.id === selectedOpenCodeSessionId)
    : null;
  const pinRef = useRef<{ sid: string; id: string | null }>({ sid: sessionId, id: null });
  if (pinRef.current.sid !== sessionId) pinRef.current = { sid: sessionId, id: null };
  if (!pinRef.current.id && rootSessionId) pinRef.current.id = rootSessionId;
  const chatSessionId = selectedSession?.id ?? pinRef.current.id ?? rootSessionId ?? null;

  // Migrate the home-composer prompt onto SessionChat's consumer key DURING RENDER.
  const promptMigratedForRef = useRef<string | null>(null);
  if (
    typeof window !== 'undefined' &&
    chatSessionId &&
    promptMigratedForRef.current !== chatSessionId
  ) {
    promptMigratedForRef.current = chatSessionId;
    const fromKey = `project_pending_prompt:${sessionId}`;
    const pending = sessionStorage.getItem(fromKey);
    if (pending) {
      const toKey = `opencode_pending_prompt:${chatSessionId}`;
      if (sessionStorage.getItem(toKey) === null) sessionStorage.setItem(toKey, pending);
      sessionStorage.removeItem(fromKey);
    }
    const fromOptKey = `project_pending_options:${sessionId}`;
    const pendingOptions = sessionStorage.getItem(fromOptKey);
    if (pendingOptions) {
      const toOptKey = `opencode_pending_options:${chatSessionId}`;
      if (sessionStorage.getItem(toOptKey) === null)
        sessionStorage.setItem(toOptKey, pendingOptions);
      sessionStorage.removeItem(fromOptKey);
    }
  }

  // ── Readiness benchmarking marks ───────────────────────────────────────
  useEffect(() => {
    if (runtimeReady) sessionMark(sessionId, 'runtime-ready');
  }, [runtimeReady, sessionId]);
  useEffect(() => {
    if (sessionsListed) sessionMark(sessionId, 'opencode-listed');
  }, [sessionsListed, sessionId]);
  useEffect(() => {
    if (!chatSessionId) return;
    sessionMark(sessionId, 'chat-ready');
    const sb = queryClient.getQueryData<{ metadata?: Record<string, unknown> }>([
      'project',
      'session-sandbox',
      projectId,
      sessionId,
    ]);
    finishSessionTiming(sessionId, sb?.metadata?.provisionTimeline);
  }, [chatSessionId, sessionId, projectId, queryClient]);

  const chatShowable =
    (!!chatSessionId && runtimeReady) || !!runtimeError || (!runtimeReady && !!runtimeBootError);
  useEffect(() => {
    if (chatShowable) onChatReady?.();
  }, [chatShowable, onChatReady]);

  useEffect(() => {
    if (!selectedOpenCodeSessionId) return;
    if (selectedSession) return;
    if (sessionsLoading) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('oc');
    const query = params.toString();
    router.replace(
      query
        ? `/projects/${projectId}/sessions/${sessionId}?${query}`
        : `/projects/${projectId}/sessions/${sessionId}`,
      { scroll: false },
    );
  }, [
    selectedOpenCodeSessionId,
    selectedSession,
    sessionsLoading,
    searchParams,
    router,
    projectId,
    sessionId,
  ]);

  if (!runtimeReady && runtimeBootError) {
    return (
      <InlineSessionError
        title={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line380JsxAttrTitleOpencodeRuntimeIsNotReady',
        )}
        message={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line381JsxAttrMessageTheSandboxBootedButTheProjectRuntimeDid',
        )}
        detail={runtimeBootError}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => restartMutation.mutate()}
            disabled={restartMutation.isPending}
          >
            {restartMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line395JsxTextRestartSession')}
          </Button>
        }
      />
    );
  }

  if (runtimeError) {
    const formatted = formatOpenCodeRuntimeError(runtimeError);
    const restartError = restartMutation.error
      ? formatOpenCodeRuntimeError(restartMutation.error)
      : null;
    return (
      <InlineSessionError
        title={formatted.title}
        message={formatted.message}
        detail={restartError?.message ?? formatted.detail}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => restartMutation.mutate()}
            disabled={restartMutation.isPending}
          >
            {restartMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line424JsxTextRestartSession')}
          </Button>
        }
      />
    );
  }

  if (!chatSessionId) {
    return null;
  }

  return (
    <SessionLayout
      key={chatSessionId}
      sessionId={chatSessionId}
      projectId={projectId}
      projectSessionId={sessionId}
    >
      <SessionChat key={chatSessionId} sessionId={chatSessionId} projectId={projectId} />
    </SessionLayout>
  );
}
