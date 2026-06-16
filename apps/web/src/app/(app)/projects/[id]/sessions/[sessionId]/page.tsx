'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

import { ProjectShell } from '@/components/projects/project-shell';
import { SessionChat } from '@/components/session/session-chat';
import { SessionLayout } from '@/components/session/session-layout';
import { SessionStartingLoader } from '@/components/session/session-starting-loader';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountState } from '@/hooks/billing';
import {
  clearOpencodeEnsureGuard,
  useCanonicalOpenCodeSession,
} from '@/hooks/opencode/use-canonical-opencode-session';
import { OpenCodeEventStreamProvider } from '@/hooks/opencode/use-opencode-events';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { isBillingEnabled } from '@/lib/config';
import { setActiveInstanceCookie } from '@/lib/instance-routes';
import { formatOpenCodeRuntimeError } from '@/lib/opencode-errors';
import {
  getProjectDetail,
  restartProjectSession,
  startProjectSession,
  syncOpencodeSessionData,
} from '@/lib/projects-client';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';
import {
  markProvisioningVerified,
  useSandboxConnectionStore,
} from '@/stores/sandbox-connection-store';
import { switchToSessionSandboxAsync, useServerStore } from '@/stores/server-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';

/**
 * /projects/[id]/sessions/[sessionId] — project-scoped session view.
 *
 * Shows the repo-first chat experience pointed at this session's sandbox.
 *
 * Lifecycle gate (auth/load → provisioning → error/stopped → active) keeps
 * the placeholder branches we already had. The active branch:
 *   1. Calls `switchToInstanceAsync(sandbox_id)` to set this session's
 *      sandbox as the global active server.
 *   2. WAITS for the active server's `instanceId` to actually equal
 *      `sandbox_id` before mounting chat. This is
 *      load-bearing — every sandbox-coupled hook inside the shell
 *      (`useOpenCodeSessions`, `getClient()`, file/terminal APIs, etc.)
 *      reads `useServerStore.getActiveServerUrl()` at render time. If we
 *      mount before the switch resolves, they connect to the previous
 *      sandbox.
 *
 * The URL stays at `/projects/<id>/sessions/<sessionId>` the whole time.
 */
export default function ProjectSessionPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  // Billing gate. An account with no active plan can't run a session — the
  // backend would never provision a sandbox, so polling for one spins forever.
  // Detect "no plan" up front so we can (a) skip the sandbox poll entirely and
  // (b) render a calm gated screen instead of an infinite loader. Subscribed-
  // but-out-of-credits accounts are NOT gated (they can still CRUD).
  //
  // Scope to the account that OWNS this project (team account), not the viewer's
  // primary account — otherwise a member who owns their own personal account
  // reads the wrong "are you subscribed?" answer and the upgrade dialog targets
  // the wrong wallet. Reuses ProjectShell's project-detail query (same key).
  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const accountLoaded = !!accountState;
  const noPlan = isBillingEnabled() && accountLoaded && !accountState.subscription?.subscription_id;

  // ONE session-open call. POST /start idempotently provisions/resumes the
  // sandbox AND resolves the OpenCode pin server-side, returning a single
  // readiness payload we poll until `stage==='ready'`. This replaces the old
  // three-call dance (GET /sandbox poll + POST /wake + POST /ensure-opencode).
  // session_id == sandbox_id by construction (see session-sandbox.ts).
  const { data: start, isLoading } = useQuery({
    queryKey: ['session-start', projectId, sessionId],
    queryFn: () => startProjectSession(projectId!, sessionId!),
    enabled: !!user && !!sessionId && !!projectId && !noPlan,
    staleTime: 0,
    // Poll until the runtime is ready or a terminal stage. `retriable` is the
    // backend's authoritative "still making progress" signal; null = a transient
    // failure, so retry shortly.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 500;
      return data.retriable ? 800 : false;
    },
  });
  const sandbox = start?.sandbox ?? null;
  const startStage = start?.stage ?? 'provisioning';

  // Subscribe to the store so we can BOTH render-gate the dashboard mount and
  // drive the active-server switch off the real success condition (the active
  // server actually points at THIS sandbox). Every downstream hook reads from
  // this store. Declared above the switch effect so the effect can depend on it.
  const activeInstanceId = useServerStore((s) => {
    const active = s.servers.find((entry) => entry.id === s.activeServerId);
    return active?.instanceId;
  });

  // When the sandbox is active, register it as the active server so any
  // sandbox-coupled UI reads ITS OpenCode URL. This RE-ATTEMPTS until the store
  // actually points at this sandbox, rather than latching on the first attempt.
  // The previous one-shot ref wedged the page on the loading skeleton forever —
  // recoverable ONLY by a hard refresh — whenever the switch no-oped: the row
  // read as `active` before `external_id` was written, a stale activeServerId
  // rehydrated from a prior session (the store is persisted), or a competing
  // switch stole it. Nothing ever re-asserted this session's sandbox.
  // switchToSessionSandboxAsync is idempotent (fast-paths when already active),
  // so re-running until activeInstanceId matches is safe.
  const switchingRef = useRef(false);
  useEffect(() => {
    if (!sandbox || !projectId) return;
    // Wait for a fully-usable row; do NOT record any "attempted" state here, or
    // a transient active-without-external_id read would block every later retry.
    if (sandbox.status !== 'active' || !sandbox.external_id) return;
    if (activeInstanceId === sandbox.sandbox_id) return; // already switched — done
    if (switchingRef.current) return; // a switch is already in flight
    switchingRef.current = true;
    sessionMark(sandbox.session_id, 'sandbox-active');
    (async () => {
      try {
        markProvisioningVerified();
        // Pass the already-fetched row so the switch skips a duplicate
        // GET /sessions/:id/sandbox on first open. OpenCode caches are scoped
        // per-sandbox (opencodeKeys / activeServerKey), so no teardown needed.
        await switchToSessionSandboxAsync(projectId, sandbox.sandbox_id, sandbox);
        // Hard-clear the legacy cookie so no later navigation can be hijacked.
        setActiveInstanceCookie(null);
      } finally {
        switchingRef.current = false;
      }
    })();
  }, [sandbox, projectId, activeInstanceId]);

  // Belt-and-suspenders: every render on this route force-clears the cookie.
  useEffect(() => {
    setActiveInstanceCookie(null);
  });

  useEffect(() => {
    if (sandbox && activeInstanceId === sandbox.sandbox_id) {
      sessionMark(sandbox.session_id, 'server-switched');
    }
  }, [activeInstanceId, sandbox]);

  // (Wake-on-open removed: POST /start now resumes an idle/hibernated box as part
  // of the single open call — no separate best-effort wake round-trip.)

  // The moment we know there's no plan, pop the one Team plan modal — don't
  // wait for a sandbox boot + 402 (which made it look like a session got
  // created first).
  const billingGatedRef = useRef(false);
  useEffect(() => {
    if (!noPlan || billingGatedRef.current) return;
    billingGatedRef.current = true;
    openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
  }, [noPlan, openUpgradeDialog, projectAccountId]);

  // From the first paint we mount ProjectShell so the project's sidebar is
  // always visible — no full-page "Preparing workspace" flash. The inner
  // content swaps between an inline loader, an error card, and the chat.
  const sandboxLabel = sandbox ? `session ${sandbox.sandbox_id.slice(0, 8)}` : undefined;
  const inner = (() => {
    if (authLoading || !user) {
      return <SessionStartingLoader />;
    }

    // No plan → don't spin on a sandbox that will never provision. Show a calm
    // gated screen (the Team plan modal is already opening over it).
    if (noPlan) {
      return (
        <InlineSessionError
          title="Subscribe to start sessions"
          message="Your team isn't on a plan yet. Subscribe to Kortix Team to run sessions, with LLM compute and AI Computers for every teammate."
          action={
            <Button
              onClick={() =>
                openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId })
              }
            >
              Subscribe to Team plan
            </Button>
          }
        />
      );
    }

    if (isLoading || !sandbox) {
      return <SessionStartingLoader stage={startStage} />;
    }

    if (sandbox.status === 'provisioning') {
      return <SessionStartingLoader stage={startStage} />;
    }

    if (sandbox.status === 'error') {
      const meta = (sandbox.metadata as Record<string, unknown>) ?? {};
      return (
        <InlineSessionError
          title={`Couldn't start ${sandboxLabel ?? 'session'}`}
          message={
            (meta.provisioningError as string) ||
            (meta.errorMessage as string) ||
            'Something went wrong while provisioning this session.'
          }
        />
      );
    }

    if (sandbox.status === 'stopped') {
      return (
        <InlineSessionError
          title={`${sandboxLabel ?? 'session'} is stopped`}
          message={tHardcodedUi.raw(
            'appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen',
          )}
        />
      );
    }

    // Active — wait until the server-store has actually flipped to this
    // sandbox before mounting the chat (downstream hooks read from the store).
    if (activeInstanceId !== sandbox.sandbox_id) {
      return <SessionStartingLoader stage={startStage} />;
    }

    return (
      <ProjectSessionRuntimeConnection>
        <OpenCodeEventStreamProvider />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ActiveSessionChat
            projectId={projectId}
            sessionId={sessionId}
            pinFromStart={start?.opencode_session_id ?? null}
          />
        </div>
      </ProjectSessionRuntimeConnection>
    );
  })();

  return <ProjectShell projectId={projectId}>{inner}</ProjectShell>;
}

function ProjectSessionRuntimeConnection({ children }: { children: ReactNode }) {
  // Drives the sandbox-connection-store so `useOpenCodeRuntimeReady()` inside
  // ActiveSessionChat can transition to `connected + healthy`. Mount this only
  // after the server store has switched to the project session sandbox, so we
  // do not briefly probe the stale default sandbox on first paint.
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
 * If no OpenCode chat session exists in the sandbox yet, auto-create one on
 * first runtime-ready render so the user lands inside the conversation UI
 * immediately.
 */
function ActiveSessionChat({
  projectId,
  sessionId,
  pinFromStart,
}: {
  projectId: string;
  sessionId: string;
  pinFromStart: string | null;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const runtimeReady = useSandboxConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  const runtimeBootError = useSandboxConnectionStore((s) => s.runtimeError);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Canonical OpenCode-session ↔ Kortix-session mapping: honors the persisted
  // pin while it still exists, deterministically adopts the oldest root when it
  // doesn't, creates at most one root per sandbox, and self-heals the pin. See
  // use-canonical-opencode-session.ts for the full invariant.
  const {
    rootSessionId,
    sessions: opencodeSessions,
    isLoading: sessionsLoading,
    listed: sessionsListed,
    error: runtimeError,
  } = useCanonicalOpenCodeSession({ projectId, sessionId, pinFromStart });

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId, sessionId),
    onSuccess: () => {
      // Restart tears down the runtime: re-enable the one-shot ensure for the
      // (new) sandbox and drop the now-stale OpenCode caches.
      clearOpencodeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
      });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
  });

  // Explicit ?oc= navigation targets a specific (often sub-) session and
  // overrides the canonical root; otherwise we render the pinned/healed root.
  const selectedOpenCodeSessionId = searchParams.get('oc');
  const selectedSession = selectedOpenCodeSessionId
    ? opencodeSessions.find((session) => session.id === selectedOpenCodeSessionId)
    : null;
  const chatSessionId = selectedSession?.id ?? rootSessionId ?? null;

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

  // Mirror the sandbox-local OpenCode session tree into our cloud DB. The
  // project session row stays the branch/sandbox root; this metadata lets the
  // project sidebar and session list render sub-sessions without guessing.
  // Must run BEFORE any conditional return — otherwise the runtimeError branch
  // below would skip this hook and trigger "rendered fewer hooks than expected".
  const activeSession = opencodeSessions.find((s) => s.id === chatSessionId);
  const activeTitle = activeSession?.title || null;
  useEffect(() => {
    if (opencodeSessions.length === 0) return;
    void syncOpencodeSessionData(
      opencodeSessions.map((session) => ({
        opencode_session_id: session.id,
        title: session.title || null,
        parent_id: session.parentID ?? null,
        project_id: session.projectID ?? null,
        created_at: session.time?.created ?? null,
        updated_at: session.time?.updated ?? null,
        archived_at: session.time?.archived ?? null,
      })),
    )
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        queryClient.invalidateQueries({ queryKey: ['project-session', projectId, sessionId] });
      })
      .catch(() => {});
  }, [opencodeSessions, activeTitle, queryClient, projectId, sessionId]);

  // First-message handoff from the project index composer (/projects/[id]). It
  // stashes the prompt under the PROJECT session id because the opencode
  // session id doesn't exist yet at navigation time. Once the chat session is
  // created, move it onto the `opencode_pending_prompt:<chatSessionId>` key that
  // SessionChat's pending-prompt effect consumes (its 250ms retry loop covers
  // the brief gap before this runs). Files ride along via usePendingFilesStore.
  const promptMovedRef = useRef(false);
  useEffect(() => {
    if (!chatSessionId || promptMovedRef.current) return;
    if (typeof window === 'undefined') return;
    const key = `project_pending_prompt:${sessionId}`;
    const pending = sessionStorage.getItem(key);
    if (!pending) return;
    promptMovedRef.current = true;
    sessionStorage.setItem(`opencode_pending_prompt:${chatSessionId}`, pending);
    sessionStorage.removeItem(key);
  }, [chatSessionId, sessionId]);

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

  // Sandbox is up + switched; we're waiting on the runtime health + the canonical
  // OpenCode pin. Keep the SAME single progress loader on its final "Connecting"
  // phase rather than swapping to a second, different skeleton — one continuous
  // 0→100% loader until the conversation is actually ready.
  if (!chatSessionId) {
    return <SessionStartingLoader stage="ready" />;
  }

  return (
    <SessionLayout sessionId={chatSessionId}>
      <SessionChat sessionId={chatSessionId} />
    </SessionLayout>
  );
}
