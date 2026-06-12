'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useRef, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { useAccountState } from '@/hooks/billing';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { isBillingEnabled } from '@/lib/config';
import { SessionLoadingSkeleton } from '@/components/session/session-loading-skeleton';
import { ProjectShell } from '@/components/projects/project-shell';
import { Button } from '@/components/ui/button';
import { OpenCodeEventStreamProvider } from '@/hooks/opencode/use-opencode-events';
import {
  getProjectDetail,
  getProjectSessionSandbox,
  restartProjectSession,
  syncOpencodeSessionData,
  wakeProjectSession,
} from '@/lib/projects-client';
import { setActiveInstanceCookie } from '@/lib/instance-routes';
import { formatOpenCodeRuntimeError } from '@/lib/opencode-errors';
import {
  markProvisioningVerified,
  useSandboxConnectionStore,
} from '@/stores/sandbox-connection-store';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { switchToSessionSandboxAsync, useServerStore } from '@/stores/server-store';
import {
  clearOpencodeEnsureGuard,
  useCanonicalOpenCodeSession,
} from '@/hooks/opencode/use-canonical-opencode-session';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';

const SessionLayout = dynamic(
  () => import('@/components/session/session-layout').then((mod) => mod.SessionLayout),
  { loading: () => <SessionLoadingSkeleton /> },
);

const SessionChat = dynamic(
  () => import('@/components/session/session-chat').then((mod) => mod.SessionChat),
  { loading: () => <SessionLoadingSkeleton /> },
);

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
  const noPlan =
    isBillingEnabled() && accountLoaded && !accountState.subscription?.subscription_id;

  // session_id == sandbox_id by construction (see session-sandbox.ts).
  const { data: sandbox, isLoading } = useQuery({
    queryKey: ['project', 'session-sandbox', projectId, sessionId],
    queryFn: () => getProjectSessionSandbox(projectId!, sessionId!),
    enabled: !!user && !!sessionId && !!projectId && !noPlan,
    staleTime: 0,
    // Poll while the row is missing (returns null) OR while still provisioning.
    // Tight cadence so the UI flips to the sandbox the instant the backend
    // marks it active — the provisioning wall is the backend's, not ours.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 300;
      return data.status === 'provisioning' ? 300 : false;
    },
  });

  // When the sandbox is active, register it as the active server so any
  // sandbox-coupled UI inside the dashboard reads ITS OpenCode URL.
  // CRITICAL: clear the legacy `kortix-active-instance` cookie afterwards
  // (and on every render). With it set, middleware can hijack client-side
  // navigation away from the project/session URL. We never want that.
  const switchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sandbox || !projectId) return;
    if (sandbox.status !== 'active') return;
    if (switchedRef.current === sandbox.sandbox_id) return;
    switchedRef.current = sandbox.sandbox_id;
    sessionMark(sandbox.session_id, 'sandbox-active');
    (async () => {
      markProvisioningVerified();
      // No cache teardown here anymore. OpenCode caches (query keys + the
      // localStorage placeholders) and the message sync store are now scoped
      // per-sandbox (see opencodeKeys / activeServerKey), so the previous
      // sandbox's data can't bleed into this one — and keeping it cached is
      // exactly what makes switching back to an already-open session instant
      // instead of reloading.
      // Pass the already-fetched row so the switch skips a duplicate
      // GET /sessions/:id/sandbox on first open.
      await switchToSessionSandboxAsync(projectId, sandbox.sandbox_id, sandbox);
      // Hard-clear the cookie so no subsequent navigation can be hijacked.
      setActiveInstanceCookie(null);
    })();
  }, [sandbox, projectId, queryClient]);

  // Belt-and-suspenders: every render on this route force-clears the cookie.
  useEffect(() => {
    setActiveInstanceCookie(null);
  });

  // Subscribe to the store so we can render-gate the dashboard mount until
  // the active server has actually flipped to THIS sandbox (see the docblock
  // at the top — every downstream hook reads from this store).
  const activeInstanceId = useServerStore((s) => {
    const active = s.servers.find((entry) => entry.id === s.activeServerId);
    return active?.instanceId;
  });

  useEffect(() => {
    if (sandbox && activeInstanceId === sandbox.sandbox_id) {
      sessionMark(sandbox.session_id, 'server-switched');
    }
  }, [activeInstanceId, sandbox]);

  // Wake-on-open: the DB row reads `active` even after the provider auto-stops
  // an idle sandbox, so opening such a session would spin the health poll
  // against a dead container. Fire a best-effort wake once when the row is
  // active — a running sandbox is a cheap no-op; a stopped one starts warming
  // immediately while the health poll picks up readiness.
  const wokeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sandbox || !projectId) return;
    if (sandbox.status !== 'active') return;
    if (wokeRef.current === sandbox.sandbox_id) return;
    wokeRef.current = sandbox.sandbox_id;
    void wakeProjectSession(projectId, sandbox.session_id).catch(() => {});
  }, [sandbox, projectId]);

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
      return <SessionLoadingSkeleton />;
    }

    // No plan → don't spin on a sandbox that will never provision. Show a calm
    // gated screen (the Team plan modal is already opening over it).
    if (noPlan) {
      return (
        <InlineSessionError
          title="Subscribe to start sessions"
          message="Your team isn't on a plan yet. Subscribe to Kortix Team to run sessions, with LLM compute and AI Computers for every teammate."
          action={
            <Button onClick={() => openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId })}>
              Subscribe to Team plan
            </Button>
          }
        />
      );
    }

    if (isLoading || !sandbox) {
      return <SessionLoadingSkeleton />;
    }

    if (sandbox.status === 'provisioning') {
      return <SessionLoadingSkeleton />;
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
          message={tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen')}
        />
      );
    }

    // Active — wait until the server-store has actually flipped to this
    // sandbox before mounting the chat (downstream hooks read from the store).
    if (activeInstanceId !== sandbox.sandbox_id) {
      return <SessionLoadingSkeleton />;
    }

    return (
      <ProjectSessionRuntimeConnection>
        <OpenCodeEventStreamProvider />
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ActiveSessionChat projectId={projectId} sessionId={sessionId} />
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
    <div className="flex-1 min-h-0 flex items-center justify-center px-6">
      <div className="max-w-md text-center flex flex-col items-center gap-3">
        <h2 className="text-sm font-medium text-foreground/90">{title}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground/70">{message}</p>
        {detail ? (
          <p className="max-w-full rounded-2xl border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs leading-relaxed text-muted-foreground">
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
}: {
  projectId: string;
  sessionId: string;
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
  } = useCanonicalOpenCodeSession({ projectId, sessionId });

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
      'project', 'session-sandbox', projectId, sessionId,
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
        title={tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line380JsxAttrTitleOpencodeRuntimeIsNotReady')}
        message={tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line381JsxAttrMessageTheSandboxBootedButTheProjectRuntimeDid')}
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
            )}{tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line395JsxTextRestartSession')}</Button>
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
            )}{tHardcodedUi.raw('appProjectsIdSessionsSessionidPage.line424JsxTextRestartSession')}</Button>
        }
      />
    );
  }

  if (!chatSessionId) {
    return <SessionLoadingSkeleton />;
  }

  return (
    <SessionLayout sessionId={chatSessionId}>
      <SessionChat sessionId={chatSessionId} />
    </SessionLayout>
  );
}
