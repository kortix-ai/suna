'use client';

import { useTranslations } from 'next-intl';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  sessionStartKey,
  startProjectSession,
  syncOpencodeSessionData,
} from '@/lib/projects-client';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
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
  const { data: start } = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
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

  // ── Crossfade: ONE persistent loader fades out as the chat fades in ───────
  // The loader is rendered at a SINGLE stable tree position for the whole
  // pre-ready lifecycle, so it never remounts → never re-blanks its delay gate
  // (the old "disappears for a second then reappears" bug). The chat mounts
  // UNDER the loader the moment the sandbox is switched, warms up invisibly,
  // then crossfades in once ActiveSessionChat reports it's actually ready.
  const [chatReady, setChatReady] = useState(false);
  const [loaderMounted, setLoaderMounted] = useState(true);
  // Reset the crossfade when the route's session changes (render-phase, idempotent).
  const lifecycleForRef = useRef<string | null>(null);
  if (lifecycleForRef.current !== sessionId) {
    lifecycleForRef.current = sessionId;
    if (chatReady) setChatReady(false);
    if (!loaderMounted) setLoaderMounted(true);
  }

  // Terminal/gated states fully REPLACE the content (no chat to fade to).
  const gated = !authLoading && !!user && noPlan;
  const fatal =
    !authLoading &&
    !!user &&
    !!sandbox &&
    (sandbox.status === 'error' || sandbox.status === 'stopped');
  // Mount the chat subtree only once the server store points at THIS sandbox —
  // every sandbox-coupled hook reads the active server at render time.
  const canMountChat =
    !!sandbox && sandbox.status === 'active' && activeInstanceId === sandbox.sandbox_id;

  // From the first paint we mount ProjectShell so the project's sidebar is
  // always visible — no full-page "Preparing workspace" flash.
  const sandboxLabel = sandbox ? `session ${sandbox.sandbox_id.slice(0, 8)}` : undefined;
  const inner = (() => {
    // No plan → don't spin on a sandbox that will never provision. Show a calm
    // gated screen (the Team plan modal is already opening over it).
    if (gated) {
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

    if (fatal) {
      const meta = (sandbox!.metadata as Record<string, unknown>) ?? {};
      return sandbox!.status === 'error' ? (
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
          message={tHardcodedUi.raw(
            'appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen',
          )}
        />
      );
    }

    // Dual-layer: the chat mounts under a persistent loader and crossfades in.
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
              <OpenCodeEventStreamProvider />
              <ActiveSessionChat
                projectId={projectId}
                sessionId={sessionId}
                pinFromStart={start?.opencode_session_id ?? null}
                onChatReady={() => setChatReady(true)}
              />
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
            <SessionStartingLoader stage={authLoading || !user ? 'provisioning' : startStage} />
          </div>
        )}
      </div>
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
  onChatReady,
}: {
  projectId: string;
  sessionId: string;
  pinFromStart: string | null;
  /** Called once the chat is actually showable (resolved + healthy, or erroring)
   *  so the page can crossfade it in over the loader. */
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
      // Restart tears down the runtime: re-enable the one-shot ensure for the
      // (new) sandbox and drop the now-stale OpenCode caches.
      clearOpencodeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
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
  // Pin the FIRST resolved root id so the pinFromStart(null)→pin transition can
  // never re-key SessionChat mid-start — a re-key would remount it, dropping the
  // optimistic first-message bubble and interrupting the send (so OpenCode never
  // auto-titles the session). ?oc deep-links still override. Reset per route.
  const pinRef = useRef<{ sid: string; id: string | null }>({ sid: sessionId, id: null });
  if (pinRef.current.sid !== sessionId) pinRef.current = { sid: sessionId, id: null };
  if (!pinRef.current.id && rootSessionId) pinRef.current.id = rootSessionId;
  const chatSessionId = selectedSession?.id ?? pinRef.current.id ?? rootSessionId ?? null;

  // Migrate the home-composer prompt onto SessionChat's consumer key DURING
  // RENDER — before SessionChat (a child) mounts — so its pending-prompt effect
  // always finds it, instead of racing a parent effect that runs AFTER the child.
  // Idempotent + guarded (runs once per resolved chatSessionId) → StrictMode-safe.
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

  // Tell the page to crossfade the chat in once it's genuinely showable — the
  // session id is resolved AND the runtime is healthy, OR an error card is about
  // to render (so the error replaces the loader smoothly too). setState in the
  // parent is idempotent, so re-firing on re-render is a harmless no-op.
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

  // (The home-composer first-message handoff is migrated synchronously during
  // render above — see promptMigratedForRef — so SessionChat's consumer always
  // finds the key before it mounts, instead of racing a post-mount effect.)

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

  // Sandbox up + switched, still resolving runtime health + the canonical pin.
  // Render NOTHING here (not a second loader) — the page's single persistent
  // loader is on top and crossfades out once chatShowable flips onChatReady.
  if (!chatSessionId) {
    return null;
  }

  // Key by chatSessionId (pinned, so stable through the whole start) — SessionChat
  // mounts exactly once per session and only remounts on a genuine session switch,
  // so the optimistic first-message bubble + in-flight send are never torn down.
  return (
    <SessionLayout key={chatSessionId} sessionId={chatSessionId}>
      <SessionChat key={chatSessionId} sessionId={chatSessionId} />
    </SessionLayout>
  );
}
