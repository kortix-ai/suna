'use client';

import { useTranslations } from 'next-intl';

import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { AppErrorCard, ClientErrorBoundary } from '@/components/common/error-boundary';
import { isLegacyMigratedSession, sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import { resolvePinnedRootSessionId } from '@/features/session/pinned-root-session';
import { ProviderFailureRecovery } from '@/features/session/provider-failure-recovery';
import {
  pendingSessionPromptForRecovery,
  provisioningFailurePresentation,
} from '@/features/session/provisioning-failure';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
import { SessionChat } from '@/features/session/session-chat';
import { SessionLayout } from '@/features/session/session-layout';
import {
  canMountSessionChat,
  findInitialSessionPin,
  gatedRuntimeError,
  runtimeErrorPresentation,
  sessionErrorSurfaceReady,
} from '@/features/session/session-load-state';
import {
  isAutoResuming,
  isRuntimeIdentityUnavailable,
  isSandboxResumable,
} from '@/features/session/session-resume';
import { canPollSessionStart } from '@/features/session/session-start-gate';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import {
  resolveSessionOverlay,
  shouldForgetNewSessionHint,
  shouldMountSessionChat,
} from '@/features/session/session-surface';
import {
  canRenderCachedTranscriptWhileSandboxDown,
  isDormantSessionWithoutRuntime,
  isUnmaterializedSessionFailure,
} from '@/features/session/session-terminal-state';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useAccountState } from '@/hooks/billing';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { useRestartProjectSession } from '@/hooks/projects/use-restart-project-session';
import {
  billingDialogArgs,
  billingGateCopy,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { finishSessionTiming, sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import {
  shouldShowSessionSwitchLoading,
  useSessionSwitchStore,
} from '@/stores/session-switch-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
  type ProjectSession,
  formatRuntimeError,
  getProjectDetail,
  listProjectSessions,
  sessionStartKey,
  updateProjectSession,
} from '@kortix/sdk';
import { clearSessionFresh, isSessionFresh } from '@kortix/sdk/fresh-sessions';
import { setActiveInstanceCookie } from '@kortix/sdk/instance-routes';
import {
  type UseSessionResult,
  clearStartStash,
  contract,
  migrateStash,
  qk,
  readStartStash,
  startSessionWithPrompt,
  useRuntimeConnectionStore,
  useSession,
} from '@kortix/sdk/react';

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
 *
 * The route itself is deliberately thin: it reads the ids and hands them to a
 * view KEYED by session id. See {@link ProjectSessionView} for why that key is
 * load-bearing rather than tidy.
 */
export default function ProjectSessionPage() {
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();
  if (!projectId || !sessionId) return null;
  return (
    <ProjectSessionView
      key={`${projectId}/${sessionId}`}
      projectId={projectId}
      sessionId={sessionId}
    />
  );
}

/**
 * One session's view. Every piece of per-session state below is created by React
 * on mount, because the route above keys this component by session id.
 *
 * It used to be one component instance reused across session switches, resetting
 * itself from a render-phase block: two refs mutated mid-render alongside three
 * `setState` calls in the same pass. Client navigation is a transition, React may
 * throw a transition render away and start over, and the two halves do not
 * survive that equally — the ref writes persist, the queued state updates do not.
 * When they came apart the route latched onto the previous session's brand-new
 * shell and could not get out of it (see `session-surface.ts` for the deadlock),
 * so clicking a session with hours of history painted the empty project-home
 * surface until a hard reload. A key makes the whole class of desync
 * unrepresentable: switching sessions remounts, and a remount cannot half-apply.
 */
function ProjectSessionView({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Billing gate. An account that cannot run should not KEEP polling to start a
  // session — the backend would never provision a sandbox, so the poll spins
  // forever. It gates the poll, never the transcript: reading what you already
  // wrote does not need a sandbox, let alone an entitlement re-check.
  // Scope to the account that OWNS this project (team account), not the viewer's.
  const { data: projectDetail } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => {
      if (!projectId) throw new Error('Missing project id');
      return getProjectDetail(projectId);
    },
    enabled: !!projectId,
    ...contract('config'),
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState } = useAccountState({
    accountId: projectAccountId,
  });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const accountLoaded = !!accountState;
  // ONE resolver for "what is this account's billing situation" (see
  // lib/billing/billing-gate-state.ts). This used to be `!can_run`, rendered as
  // `noPlan` with a "Subscribe to Team plan" pitch — which told a Team account
  // on an ACTIVE $40/mo subscription with a $0.0099 wallet that it had no plan,
  // while the modal that CTA opened correctly said "Out of credits — your Team
  // plan and seats are unaffected". `can_run: false` means blocked, not unplanned.
  const billingState = isBillingEnabled() ? resolveBillingState(accountState) : null;
  const billingBlocked =
    isBillingEnabled() && accountLoaded && !billingStateAllowsRun(billingState);
  const { data: projectSessions } = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled: !!user && !!projectId,
    // This query feeds the session HEADER's title. It had no interval at all,
    // so it never refetched — the header was only ever correct because it
    // shares this cache entry with the sidebar's list, and went stale the
    // moment the sidebar was unmounted or had stopped polling. The name is
    // written server-side seconds AFTER the first prompt with no event to
    // announce it (see `sessionTitleHasLanded`), so a query that never
    // refetches can never show it.
    //
    // `hasOpenSession: true` unconditionally: this route IS an open session.
    refetchInterval: (query) =>
      projectSessionsRefetchInterval({
        sessions: query.state.data as ProjectSession[] | undefined,
        hasOpenSession: true,
      }),
    refetchOnWindowFocus: false,
    ...contract('inventory'),
  });
  const currentProjectSession = projectSessions?.find((item) => item.session_id === sessionId);
  const pendingPrompt = pendingSessionPromptForRecovery(sessionId, currentProjectSession?.metadata);
  const initialOpenCodeSessionId = findInitialSessionPin(projectSessions, sessionId);

  // ONE hook owns the runtime: POST /start (idempotent provision/resume + the
  // server-resolved OpenCode pin), the sandbox switch, the SSE stream, readiness
  // seeding (no client health poll), and the canonical id. The billing gate is
  // monotonic (see canPollSessionStart) so a no-plan account still stops polling
  // for a sandbox that won't provision, without the old open→shut→open flip
  // interrupting an in-flight wake.
  // replayStartStash:false — the web has its own pending-prompt hand-off (below).
  // The default chat engine stays enabled. This hook owns message sync and the
  // question and permission recovery pollers for the root session.
  const session = useSession(projectId, sessionId, {
    enabled: canPollSessionStart({ hasUser: !!user, billingBlocked }),
    replayStartStash: false,
    initialOpenCodeSessionId,
  });
  const sandbox = session.sandbox;
  const startStage = session.stage ?? 'provisioning';
  // The immutable agent this session was created with — known BEFORE the
  // sandbox is ready (the sessions-list row is usually already cached from the
  // sidebar; `/start`'s first response carries it as well). Handed to every
  // composer on this route so the picker renders the session's real agent from
  // the first frame instead of guessing `selectable[0]` from the roster while
  // booting, then "correcting" itself once ready. `'default'` is the server's
  // spelling of "no agent bound" (see shared.ts serializers), not a roster
  // agent — it must not shadow the project default.
  // The start-stash covers the window BEFORE either server source answers: on
  // the optimistic home→session redirect the producer stashed the picked agent
  // under this route id (`writeStartStash`), and the picker must not fall back
  // to the project default for the second it takes /start to respond. Lazy
  // state, read once per mount: the stash is consumed later in this session's
  // life, and re-reading it on every render would flip this back to null.
  const [stashAgentName] = useState(() => readStartStash(sessionId)?.agent?.trim() || null);
  const listAgentName = currentProjectSession?.agent_name?.trim();
  const boundAgentName =
    (listAgentName && listAgentName !== 'default' ? listAgentName : null) ??
    session.agentName ??
    stashAgentName;
  const switchingToSessionId = useSessionSwitchStore((state) => state.targetSessionId);
  const completeSessionSwitch = useSessionSwitchStore((state) => state.completeSwitch);

  // ── Auto-resume a hibernated-but-resumable sandbox ────────────────────────
  // On the first /start of an idle-stopped session the backend can race into a
  // TERMINAL 'stopped' (openSession's self-preserve path on a transient provider
  // getStatus()) even though the row is left EXACTLY resumable (status 'stopped'
  // + external_id). useSession then stops polling and the page used to pin a
  // dead-end "open a new session" card — yet a hard refresh's fresh /start hits
  // the resume path and wakes the box. So: re-issue /start ourselves a few times
  // (what the refresh did) before ever surfacing a manual control.
  const sandboxResumable = isSandboxResumable(sandbox);
  const MAX_AUTO_RESUME = 3;
  const [resumeAttempts, setResumeAttempts] = useState(0);
  // ONE restart behavior for every card on this route: optimistic exit from the
  // terminal state, a real pending state, and a SURFACED failure.
  const restart = useRestartProjectSession(projectId, sessionId);
  // A manual restart re-arms auto-resume: the box the user just asked us to
  // reboot deserves the same wake attempts a fresh open would get.
  const handleRestart = () => {
    setResumeAttempts(0);
    restart.restart();
  };
  const handleProvisioningRetry = () => {
    // A LEGACY hand-off (metadata.pending_prompt.text from a pre-conversion
    // API, or a full-prompt stash) becomes a durable inbox row here — POSTed,
    // not re-stashed, so this retry is the last time it can be lost. A session
    // created by the current API needs nothing: its first prompt has been a
    // durable row since the create transaction, and the restart alone re-arms
    // delivery.
    if (pendingPrompt) {
      void startSessionWithPrompt(projectId, sessionId, {
        parts: [{ type: 'text' as const, text: pendingPrompt.text }],
        overrides: {
          ...(pendingPrompt.agent ? { agent: pendingPrompt.agent } : {}),
          ...(pendingPrompt.model ? { model: pendingPrompt.model } : {}),
          ...(pendingPrompt.variant ? { variant: pendingPrompt.variant } : {}),
        },
      })
        .then(() => {
          clearStartStash(sessionId);
          // Strip the recovered text so a later mount cannot enqueue it twice.
          return updateProjectSession(projectId, sessionId, {
            metadata: { pending_prompt: null },
          }).catch(() => undefined);
        })
        .catch((error) => {
          errorToast(error instanceof Error ? error.message : 'Could not queue the saved prompt');
        });
    }
    handleRestart();
  };
  const copyPendingPrompt = async () => {
    if (!pendingPrompt) {
      errorToast('No saved prompt is available.');
      return;
    }
    try {
      await navigator.clipboard.writeText(pendingPrompt.text);
      successToast('Prompt copied');
    } catch {
      errorToast('Could not copy the prompt.');
    }
  };
  useEffect(() => {
    if (!sandboxResumable || resumeAttempts >= MAX_AUTO_RESUME) return;
    // First attempt fires immediately (match the refresh); back off after that.
    const t = setTimeout(
      () => {
        setResumeAttempts((n) => n + 1);
        queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
      },
      resumeAttempts === 0 ? 0 : 1500,
    );
    return () => clearTimeout(t);
  }, [sandboxResumable, resumeAttempts, projectId, sessionId, queryClient]);
  // While we still have auto-resume attempts left, a resumable box is "waking",
  // not "dead" — render the boot loader, never the dead-end card.
  const autoResuming = isAutoResuming(sandbox, resumeAttempts, MAX_AUTO_RESUME);

  // Belt-and-suspenders: clear the legacy active-instance cookie once on mount for
  // this route so no later navigation can be hijacked onto a stale sandbox.
  useEffect(() => {
    setActiveInstanceCookie(null);
  }, []);

  useEffect(() => {
    if (session.switched && sandbox) {
      sessionMark(sandbox.session_id, 'server-switched');
      // The sidebar's session-list status ('running' vs 'stopped') is a SEPARATE
      // query that /start never touches, so opening a session left the dot stale
      // until a manual refresh. Refresh the list once the runtime switches in so
      // the status flips to running on its own.
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    }
  }, [session.switched, sandbox, queryClient, projectId]);

  // The moment we know the account is blocked, pop the ONE billing modal — with
  // the state that produced the block, so the modal shows the same thing the
  // gate card says (top-up vs subscribe), never the opposite.
  const billingGatedRef = useRef(false);
  useEffect(() => {
    if (!billingBlocked || billingGatedRef.current) return;
    billingGatedRef.current = true;
    openUpgradeDialog(billingDialogArgs(billingState, accountState, projectAccountId));
  }, [billingBlocked, billingState, accountState, openUpgradeDialog, projectAccountId]);

  // ── Crossfade: the overlay fades out as the real chat fades in ────────────
  // The overlay (a fully-interactive new-session shell, or the boot loader for a
  // resume) occupies a SINGLE stable tree position for the whole pre-ready
  // lifecycle, so nothing under it remounts as the boot advances.
  const [chatReady, setChatReady] = useState(false);
  // Stable: it rides an effect dependency inside SessionChat, and a fresh arrow
  // every render would re-run that effect on every render of this route.
  const handleChatReady = useCallback(() => setChatReady(true), []);
  const [loaderMounted, setLoaderMounted] = useState(true);
  // Belt and braces for the `onTransitionEnd` unmount below: `transitionend`
  // never fires when the tab is backgrounded mid-fade, nor under
  // `prefers-reduced-motion` where the duration is 0. Without this the loader
  // subtree — including its 1s boot-clock interval — stays mounted behind
  // `opacity-0` for the rest of the session.
  useEffect(() => {
    if (!chatReady || !loaderMounted) return;
    const t = setTimeout(() => setLoaderMounted(false), 350);
    return () => clearTimeout(t);
  }, [chatReady, loaderMounted]);
  // Seeded ONCE, on mount, in a single initializer — both halves of the hand-off
  // are read in the same pass and land in the same commit, so they cannot come
  // apart the way the old render-phase ref/setState pair could. There is no
  // per-session reset to hand-roll: the route keys this component by session id.
  //
  // `readStartStash` is one check that sees a stash from every producer
  // (canonical `kortix:start:<id>` or either legacy shape) without knowing which
  // key it lives under — it replaced two raw legacy-key checks
  // (`opencode_pending_prompt:<id>` / `project_pending_prompt:<id>`).
  const [handoff] = useState(() => {
    if (typeof window === 'undefined')
      return { pending: false, newSessionHint: false, firstPrompt: false };
    const pending = !!readStartStash(sessionId)?.prompt;
    // The project-home composer writes this before it navigates, so it is
    // already in the store on this component's first render — read here, with
    // the rest of the hand-off, rather than latched from an effect afterwards.
    const firstPrompt = !!useFirstPromptPreviewStore.getState().previewBySession[sessionId];
    return { pending, firstPrompt, newSessionHint: pending || isSessionFresh(sessionId) };
  });
  const [submittedOnShell, setSubmittedOnShell] = useState(false);
  // "The shell is painting this session's first prompt right now." TWO producers
  // put a prompt on that surface and only one of them is a send made here:
  //
  //  • `submittedOnShell` — typed into the shell and sent from it.
  //  • the first-prompt preview — sent from the PROJECT HOME, which created the
  //    session, POSTed the prompt as a durable inbox row, navigated here, and
  //    left the text in memory for the shell to draw from its first frame (see
  //    `useFirstPromptPreviewStore`).
  //
  // Only the first used to count, and the second is the flow most sessions
  // start with — so the pin that keeps the shell on screen was false for
  // exactly the case it exists for. See `resolveSessionOverlay` for what that
  // cost: the user's own bubble replaced by a boot spinner, for the length of a
  // SessionChat mount.
  //
  // Read live AND once at mount. Live so a preview planted a tick late still
  // counts; at mount because `SessionChat` CLEARS the preview the instant the
  // transcript shows the text — and that clear can land in the same commit as
  // `chatReady`, so a purely live read would drop the pin on the exact frame
  // the fade starts and unmount the shell instead of dissolving it.
  const hasFirstPromptPreview = useFirstPromptPreviewStore(
    (state) => !!state.previewBySession[sessionId],
  );
  const shellShowsFirstPrompt = submittedOnShell || hasFirstPromptPreview || handoff.firstPrompt;
  // Mounting the chat takes the same evidence plus one weaker source: a stashed
  // prompt means the message is committed and needs a runtime, so the chat
  // should be warming up. It does NOT pin the shell — a stash can outlive the
  // hand-off it describes, and a stale one must not hold a real session on a
  // bubble it no longer owns.
  const shellSubmitted = handoff.pending || shellShowsFirstPrompt;

  // Transcript evidence — the veto that keeps a stale hint from stranding a real
  // session on the empty new-session surface. It comes from `useSession`'s own
  // sync, which paints from the local IndexedDB cache WITHOUT waiting for the
  // sandbox, so it lands while a hibernated box is still waking and without the
  // chat having mounted. Latched: the store only ever grows for a live session,
  // but a transient empty read must never resurrect the shell.
  const [sawTranscript, setSawTranscript] = useState(false);
  useEffect(() => {
    if (session.messages.length > 0) setSawTranscript(true);
  }, [session.messages.length]);
  const hasTranscript = session.messages.length > 0 || sawTranscript;
  const surface = { newSessionHint: handoff.newSessionHint, hasTranscript };
  const overlay = resolveSessionOverlay({ ...surface, shellShowsFirstPrompt });

  // Drop the local hint as soon as it has done its job OR been proven wrong.
  // This used to wait on `chatReady`, which the hint itself could withhold — so
  // a wrong hint kept itself alive for the whole tab.
  useEffect(() => {
    if (shouldForgetNewSessionHint({ chatReady, hasTranscript, submitted: shellSubmitted })) {
      clearSessionFresh(sessionId);
    }
  }, [chatReady, hasTranscript, shellSubmitted, sessionId]);

  // Terminal/gated states fully REPLACE the content (no chat to fade to).
  const gated = !authLoading && !!user && billingBlocked;
  const fatal =
    !authLoading &&
    !!user &&
    !!sandbox &&
    (sandbox.status === 'error' || sandbox.status === 'stopped');
  // A preserved-unavailable identity is `status: 'stopped'` + an `external_id`,
  // so it satisfies `fatal` above and used to render the ordinary "restart it"
  // card. It needs its own terminal branch — see the render below.
  const runtimeIdentityUnavailable =
    !authLoading && !!user && isRuntimeIdentityUnavailable(sandbox);
  // A stopped/errored sandbox with a renderable cached transcript should show
  // the CONVERSATION, not the full-screen restart/waking card `fatal` forces
  // below. `hasTranscript` is already the route's own veto signal (painted from
  // the SDK sync store's IndexedDB/memory cache without waiting on a runtime —
  // see the comment on `sawTranscript` above); reading it again here, rather
  // than re-deriving cache presence, is what keeps this additive to the
  // existing chat-mount path instead of a second cache implementation.
  // Sending still waits on the runtime — `sessionComposerReadiness` shows its
  // own "waking" notice above the composer, and a prompt submitted meanwhile
  // becomes a durable inbox row the control plane delivers once the box is up,
  // rather than being dropped.
  const showCachedTranscriptWhileDown = canRenderCachedTranscriptWhileSandboxDown({
    sandboxStatus: sandbox?.status,
    hasCachedContent: hasTranscript,
  });
  // Read the RAW `/start` stage, never `session.phase` — `phase` folds a
  // terminal stage together with a typed `/start` error and a transient
  // OpenCode REST error, so a still-provisioning session used to be classified
  // as a hard provisioning failure. See session-terminal-state.ts.
  const terminalState = {
    stage: session.stage ?? null,
    retriable: session.retriable,
    hasStartError: !!session.startError,
    sandboxStatus: sandbox?.status,
  };
  const unmaterializedFailure =
    !authLoading && !!user && isUnmaterializedSessionFailure(terminalState);
  const dormantWithoutRuntime =
    !authLoading && !!user && isDormantSessionWithoutRuntime(terminalState);
  const sessionContentAvailable = canMountSessionChat({
    switched: session.switched,
    opencodeSessionId: session.opencodeSessionId,
  });
  const sessionSwitchLoading = shouldShowSessionSwitchLoading(
    switchingToSessionId,
    sessionId,
    sessionContentAvailable,
  );
  // Leaving mid-switch used to strand the target in the store: nothing cleared
  // it, so the NEXT open of that session opened straight onto the full-screen
  // switch loader. Compare-and-clear, so a rapid click-through never clears the
  // newer target (see `completeSwitch`).
  useEffect(() => {
    return () => {
      useSessionSwitchStore.getState().completeSwitch(sessionId);
    };
  }, [sessionId]);
  useEffect(() => {
    if (switchingToSessionId !== sessionId) return;
    if (
      sessionContentAvailable ||
      session.startError ||
      unmaterializedFailure ||
      dormantWithoutRuntime ||
      fatal ||
      gated
    ) {
      completeSessionSwitch(sessionId);
    }
  }, [
    switchingToSessionId,
    sessionId,
    sessionContentAvailable,
    session.startError,
    unmaterializedFailure,
    dormantWithoutRuntime,
    fatal,
    gated,
    completeSessionSwitch,
  ]);
  // Existing sessions can mount from their server-owned pin before the runtime
  // switch completes, and `useSessionSync` paints the cached transcript out of
  // IndexedDB without waiting for the sandbox, then revalidates over the live
  // runtime once useSession finishes the switch. (This comment claimed the IDB
  // hydration for a long time before anything actually called it — nothing read
  // or wrote that cache, so every open waited out a full VM wake to show text
  // the user already had.)
  const canMountChat = sessionContentAvailable;
  // For a genuinely new session, hold the real chat until the user actually sends
  // their first message — the instant shell is the typing surface until then, and
  // a second composer underneath it would fight for focus. `shouldMountSessionChat`
  // owns the rule that makes that hold safe: transcript evidence outranks the
  // hint, so a session with history is never held back (session-surface.ts).
  const mountChat = shouldMountSessionChat({
    ...surface,
    contentAvailable: canMountChat,
    submitted: shellSubmitted,
  });

  // `sandbox_id` was nullable on legacy project-session inventory rows. Keep
  // this render guard even though the current `/start` response serializes the
  // non-null `session_sandboxes` primary key. A malformed cached response must
  // degrade to the bare label instead of crashing the page (Better Stack pattern
  // e6d0e044 — `Cannot read properties of null (reading 'slice')`).
  const sandboxLabel = sandbox?.sandbox_id
    ? `session ${sandbox.sandbox_id.slice(0, 8)}`
    : undefined;
  const sessionMissing = session.startError?.status === 404 && !sandbox;
  const recoverableFailure = (() => {
    if (sessionMissing) return null;
    const metadata = (sandbox?.metadata as Record<string, unknown>) ?? {};
    if (session.failure) {
      return provisioningFailurePresentation(
        {
          ...metadata,
          failureCategory: session.failure.category,
          errorMessage: session.failure.message,
        },
        sandboxLabel ?? 'session',
      );
    }
    if (sandbox?.status === 'error') {
      return provisioningFailurePresentation(metadata, sandboxLabel ?? 'session');
    }
    if (unmaterializedFailure) {
      return provisioningFailurePresentation({}, sandboxLabel ?? 'session');
    }
    if (session.startError) {
      return provisioningFailurePresentation(
        {
          failureCategory: 'sandbox-provider',
          errorMessage: session.startError.message,
        },
        sandboxLabel ?? 'session',
      );
    }
    return null;
  })();
  const inner = (() => {
    if (sessionSwitchLoading) {
      return (
        <SessionStartingLoader
          stage={switchingToSessionId === sessionId ? startStage : 'starting'}
          projectId={projectId}
          sessionId={switchingToSessionId ?? sessionId}
        />
      );
    }

    if (gated) {
      const blockedState =
        billingState && billingState !== 'active' ? billingState : 'no_subscription';
      const copy = billingGateCopy(blockedState);
      // The genuinely-no-plan copy keeps its translated strings; the states this
      // surface used to mislabel get their copy from the shared resolver.
      const isNoPlan = blockedState === 'no_subscription';
      return (
        <InlineSessionError
          title={
            isNoPlan
              ? tI18nHardcoded.raw('autoAppAppProjectsIdSessionsSessionIdPageJsxAttrTitlebf9bba8c')
              : copy.title
          }
          message={
            isNoPlan
              ? tI18nHardcoded.raw(
                  'autoAppAppProjectsIdSessionsSessionIdPageJsxAttrMessage93bc2779',
                )
              : copy.message
          }
          action={
            <Button
              onClick={() =>
                openUpgradeDialog(billingDialogArgs(billingState, accountState, projectAccountId))
              }
            >
              {isNoPlan
                ? tI18nHardcoded.raw(
                    'autoAppAppProjectsIdSessionsSessionIdPageJsxTextSubscribe40f5b8e1',
                  )
                : copy.ctaLabel}
            </Button>
          }
        />
      );
    }

    if (sessionMissing) {
      return (
        <InlineSessionError
          title="Couldn't start session"
          message="This session is no longer available, or you do not have access to it."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/projects/${projectId}`)}
            >
              Back to project
            </Button>
          }
        />
      );
    }

    if (recoverableFailure) {
      return (
        <InlineSessionError
          title={recoverableFailure.title}
          message={recoverableFailure.message}
          detail={restart.errorMessage ?? undefined}
          action={
            <ProviderFailureRecovery
              pendingPrompt={pendingPrompt}
              isRetrying={restart.isPending}
              onRetry={handleProvisioningRetry}
              onCopy={() => void copyPendingPrompt()}
              onDelete={() => setDeleteOpen(true)}
            />
          }
        />
      );
    }

    // Stopped, with no sandbox row to describe — the `fatal` branch below reads
    // `sandbox.status`, which does not exist here, so this state used to fall
    // into the FAILURE card above and claim a session that merely stopped had
    // failed before it ever got a computer.
    if (dormantWithoutRuntime) {
      // A migrated session's first open lands here by design: it has never had
      // a computer. "Stopped" would be a lie — nothing ever ran. Say what it is
      // and make the CTA the restore it actually performs.
      if (currentProjectSession && isLegacyMigratedSession(currentProjectSession)) {
        return (
          <InlineSessionError
            title="Legacy session"
            message="This conversation was imported from Suna. Restore the session to load its chat history — its files are already in the project under legacy/."
            detail={restart.errorMessage ?? undefined}
            action={
              <RestartSessionButton
                restart={restart}
                onRestart={handleRestart}
                label="Restore session"
                pendingLabel="Restoring…"
              />
            }
          />
        );
      }
      return (
        <InlineSessionError
          title="This session is stopped"
          message="Its computer was released. Restart the session to bring it back."
          detail={restart.errorMessage ?? undefined}
          action={<RestartSessionButton restart={restart} onRestart={handleRestart} />}
        />
      );
    }

    // The provider lost this session's computer. THIS MUST NEVER HAPPEN, and
    // when it does the only honest UI is a hard stop: nothing here is
    // restartable (`/start` answers `retriable: false`, `POST /restart` answers
    // 409 forever), and this session cannot be reconstructed.
    //
    // It must NOT fall through to the generic stopped card below, which offers
    // a Restart button whose only possible outcome is that 409 — the loop prod
    // session ad4b63ac hit on 2026-08-13. It must also NEVER silently continue
    // into a fresh session: the server deliberately preserved this identity
    // instead of attaching a replacement box, and the UI must not undo that.
    // Say what happened, name the id, and stop.
    if (runtimeIdentityUnavailable) {
      return (
        <InlineSessionError
          title="This session's computer was lost"
          message="Its cloud sandbox disappeared on the provider side, so this session cannot be restarted or recovered. This is a fault on our end, not something you did — it has been reported automatically. Anything committed and pushed from this session is safe in your project's repository."
          detail={sandbox?.external_id ? `${sandbox.provider} · ${sandbox.external_id}` : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete session
            </Button>
          }
        />
      );
    }

    // `showCachedTranscriptWhileDown` VETOES the terminal card below, exactly
    // the way transcript evidence already vetoes the new-session shell above
    // (`isNewSessionSurface`) — a session with renderable history is never a
    // dead end, live sandbox or not. Falls through to the same dual-layer chat
    // mount every non-fatal open uses; nothing here needs its own render path.
    if (fatal && !showCachedTranscriptWhileDown) {
      // Stopped but resumable → we're auto-waking it. Show the boot loader, not a
      // dead-end, so the user just sees it come back (as a hard refresh would).
      if (autoResuming) {
        return (
          <SessionStartingLoader stage="starting" projectId={projectId} sessionId={sessionId} />
        );
      }
      // Auto-resume exhausted (or genuinely un-resumable): give an in-place
      // Restart instead of forcing a manual browser refresh.
      return (
        <InlineSessionError
          title={`${sandboxLabel ?? 'session'} is stopped`}
          message={tI18nHardcoded.raw(
            'appProjectsIdSessionsSessionidPage.line151JsxAttrMessageTheSandboxForThisSessionWasStoppedOpen',
          )}
          detail={restart.errorMessage ?? undefined}
          action={<RestartSessionButton restart={restart} onRestart={handleRestart} />}
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
              'absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden',
              // NO fade in. Two opacity transitions running against each other
              // do not sum to one: at the midpoint both layers sit at 0.5, so
              // the composite covers 1 - 0.5x0.5 = 75% and a quarter of the
              // page behind them shows through. Identical content on both
              // layers does not save it — the text itself washes out to 75% and
              // back. That dip IS the "everything vanished for a millisecond".
              //
              // So only ONE layer animates. This one is painted, opaque, and
              // complete underneath the whole time; the overlay above
              // dissolves off it. Coverage is 1 at every frame of the fade.
              !chatReady && 'pointer-events-none',
              // `isolate` is what makes the overlay's `bg-background` below
              // actually cover this layer. `absolute` alone is NOT a stacking
              // context, so `SessionLayout`'s `z-10` panel wrapper (and the
              // `z-20` handle, and `z-[35]` while a detail is expanded) resolved
              // against a context far ABOVE both layers and painted straight
              // through the overlay — which is how a crashed chat's "Something
              // went wrong" card ended up drawn on top of a live "Connecting"
              // loader. Isolating traps those z-indices in here, where they only
              // ever needed to order this layer's own children.
              //
              // Scoped to the overlay's lifetime on purpose: once it unmounts
              // this layer stacks exactly as it does today, so the expanded
              // detail keeps competing with the shell chrome as `session-layout`
              // intends. The panel cannot be usefully expanded behind an opaque
              // overlay anyway.
              loaderMounted && 'isolate',
            )}
          >
            <ProjectSessionRuntimeConnection>
              {mountChat && (
                <ActiveSessionChat
                  projectId={projectId}
                  sessionId={sessionId}
                  sessionState={session}
                  boundAgentName={boundAgentName}
                  chatReady={chatReady}
                  onChatReady={handleChatReady}
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
              // `bg-background` is load-bearing now that the chat below is
              // always painted: this layer has to hide it completely until the
              // fade starts. The instant shell brings its own opaque root
              // (SessionLayout), but the boot loader is a transparent centred
              // block — under it you would see the chat's own compact loader
              // through the gaps, two spinners deep.
              'bg-background absolute inset-0 flex flex-col transition-opacity duration-300 ease-out',
              chatReady ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            {overlay === 'new-session-shell' ? (
              <InstantSessionShell
                projectId={projectId}
                sessionId={sessionId}
                stage={authLoading || !user ? 'provisioning' : startStage}
                boundAgentName={boundAgentName}
                onSubmit={() => setSubmittedOnShell(true)}
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
    <>
      <SandboxLoadingBoundary>{inner}</SandboxLoadingBoundary>
      <SessionDeleteModal
        projectId={projectId}
        sessionId={sessionId}
        sessionLabel={
          currentProjectSession ? sessionDisplayLabel(currentProjectSession) : 'Failed session'
        }
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(`/projects/${projectId}`)}
      />
    </>
  );
}

function ProjectSessionRuntimeConnection({ children }: { children: ReactNode }) {
  // MID-SESSION reconnect detection only. Initial readiness is server-truth (seeded
  // by useSession from /start); this poller keeps the SDK-unified connection store's
  // status fresh so the reconnect/offline UI fires if the box drops after boot.
  useSandboxConnection();
  return <>{children}</>;
}

/* ─── The one Restart control ──────────────────────────────────────────── */

/**
 * Every terminal card on this route offers the same restart, so it renders from
 * one component: a real pending state (spinner + label + disabled, so a second
 * click cannot fire a second reboot) and no bespoke copy to drift.
 */
function RestartSessionButton({
  restart,
  onRestart,
  label = 'Restart session',
  pendingLabel = 'Restarting…',
}: {
  restart: { isPending: boolean };
  onRestart: () => void;
  label?: string;
  pendingLabel?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onRestart}
      disabled={restart.isPending}
      aria-busy={restart.isPending}
    >
      {restart.isPending ? (
        <Loading className="size-3.5 shrink-0" />
      ) : (
        <RotateCcw className="size-3.5 shrink-0" />
      )}
      {restart.isPending ? pendingLabel : label}
    </Button>
  );
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
      <ErrorState
        title={title}
        description={message}
        action={
          detail || action ? (
            <div className="flex max-w-sm flex-col items-center gap-3">
              {detail ? (
                <code className="border-border/60 bg-muted/40 text-muted-foreground max-w-full rounded-md border px-2 py-1 font-mono text-xs leading-relaxed break-all">
                  {detail}
                </code>
              ) : null}
              {action}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Renders SessionLayout + SessionChat against this project session's sandbox.
 * `useSession` owns the canonical runtime session and the optional REST session
 * list used by legacy `?oc` deep links.
 */
function ActiveSessionChat({
  projectId,
  sessionId,
  sessionState,
  boundAgentName,
  chatReady,
  onChatReady,
}: {
  projectId: string;
  sessionId: string;
  sessionState: UseSessionResult;
  /** The session's immutable creation agent, resolved by the page (sessions
   *  list row, falling back to /start's `agent_name`). */
  boundAgentName?: string | null;
  /** The route has crossfaded onto this chat. Until then it is painted behind
   *  an opaque overlay and must not take focus — see `deferComposerFocus`. */
  chatReady?: boolean;
  onChatReady?: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const runtimeReady = useRuntimeConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  const runtimeBootError = useRuntimeConnectionStore((s) => s.runtimeError);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  const rootSessionId = sessionState.opencodeSessionId;
  const runtimeSessions = sessionState.runtimeSessions;
  const sessionsLoading = sessionState.runtimeSessionsLoading;
  const sessionsListed = sessionState.runtimeSessionsListed;
  // Gate on `phase`, not the raw field: `sessionState.runtimeError` can be a
  // benign 503 racing a live `/start` wake (a parked sandbox resuming), which
  // `derivePhase` (@kortix/sdk) holds as `'starting'` until `/start` itself
  // settles or gives up (~61.5s worst case). Reading the raw field rendered
  // the panic card — and marked the chat showable below, ending the loading
  // skeleton with nothing to show — for every such race; `phase === 'error'`
  // is the SDK's own answer to "is this real." `sessionErrorSurfaceReady` below
  // gets this SAME gated value, so both consumers agree.
  const runtimeError = gatedRuntimeError({
    phase: sessionState.phase,
    runtimeError: sessionState.runtimeError,
  });

  const restart = useRestartProjectSession(projectId, sessionId);

  const selectedOpenCodeSessionId = searchParams.get('oc');
  const selectedSession = selectedOpenCodeSessionId
    ? runtimeSessions.find((session) => session.id === selectedOpenCodeSessionId)
    : null;
  // Pin the resolved root id so the chat keeps its identity if the live
  // value blips back to null mid-session — but FOLLOW a non-null change: the
  // SDK's pin precedence only climbs, so a different resolved id is a
  // higher-authority correction (e.g. a stale persisted mirror displaced by
  // the real /start pin) and holding the old latch would keep painting — and
  // delivering into — the conversation the stale pin named. See
  // resolvePinnedRootSessionId. State, not a ref written during render: this
  // component is already keyed per session by the route, so there is no
  // cross-session reset to hand-roll, and a discarded render can no longer
  // leave a pin behind that the state it belongs to never saw.
  const [pinnedRootSessionId, setPinnedRootSessionId] = useState<string | null>(null);
  useEffect(() => {
    const next = resolvePinnedRootSessionId(pinnedRootSessionId, rootSessionId);
    if (next !== pinnedRootSessionId) setPinnedRootSessionId(next);
  }, [pinnedRootSessionId, rootSessionId]);
  const chatSessionId = selectedSession?.id ?? pinnedRootSessionId ?? rootSessionId ?? null;
  const runtimePresentation = runtimeErrorPresentation({
    chatSessionId,
    runtimeError,
    runtimeBootError,
  });

  // Migrate the home-composer prompt onto the canonical SDK start-stash. Every
  // producer (project-home composer, `useConfigureThread`, the instant shell)
  // stashes under the ROUTE session id, before the canonical OpenCode session
  // exists; once it resolves, hand the stash off to `chatSessionId`'s stash,
  // which `readStartStash` (SessionChat's pending-prompt effect, or
  // `useSession`'s own replay) reads uniformly. `migrateStash` understands both
  // the canonical shape and any producer that still writes the older bare-prompt
  // legacy shape at the route id.
  //
  // In an effect, not during render — SessionChat's replay retries the read
  // across exactly this write race (`writeRaceAttempts`), so arriving a tick
  // later costs nothing, and a render React discards can no longer move a user's
  // prompt into a namespace the surviving state knows nothing about. This
  // component only mounts once a fresh session's first message has been stashed
  // (see `shouldMountSessionChat`), so mount-time is never too early.
  useEffect(() => {
    if (!chatSessionId) return;
    migrateStash(sessionId, chatSessionId);
    // No queue hand-off beside it any more. The browser queue was keyed by the
    // OpenCode session id, which changes as the pin resolves, so the instant
    // shell's messages had to be moved from the route id onto the pin or they
    // were orphaned (#6110). The inbox is keyed by the KORTIX session id — the
    // route id — which never changes, so there is nothing to adopt.
  }, [sessionId, chatSessionId]);

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
    const sb = queryClient.getQueryData<{ metadata?: Record<string, unknown> }>(
      qk.project.sessionSandbox(projectId, sessionId),
    );
    finishSessionTiming(sessionId, sb?.metadata?.provisionTimeline);
  }, [chatSessionId, sessionId, projectId, queryClient]);

  // The ERROR surfaces below are ready the moment they exist — they render an
  // `InlineSessionError` immediately, so holding the shell over one would just
  // hide the message. The conversation is not: `chatSessionId` resolving only
  // means SessionChat can MOUNT, and for a beat after that it still paints its
  // own compact "starting" loader. Crossfading onto that loader replaced the
  // instant shell's live thread — the user's bubble and its "Thinking" row —
  // with a spinner, then swapped again a moment later. So the chat's own
  // `onContentReady` drives the fade for the ordinary path, and this covers the
  // two terminal ones.
  const errorSurfaceReady = runtimePresentation.replaceSession
    ? sessionErrorSurfaceReady({ runtimeError, runtimeBootError })
    : false;
  useEffect(() => {
    if (errorSurfaceReady) onChatReady?.();
  }, [errorSurfaceReady, onChatReady]);

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

  if (!runtimeReady && runtimeBootError && runtimePresentation.replaceSession) {
    return (
      <InlineSessionError
        title={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line380JsxAttrTitleOpencodeRuntimeIsNotReady',
        )}
        message={tHardcodedUi.raw(
          'appProjectsIdSessionsSessionidPage.line381JsxAttrMessageTheSandboxBootedButTheProjectRuntimeDid',
        )}
        detail={restart.errorMessage ?? runtimeBootError}
        action={<RestartSessionButton restart={restart} onRestart={restart.restart} />}
      />
    );
  }

  if (runtimeError && runtimePresentation.replaceSession) {
    const formatted = formatRuntimeError(runtimeError);
    return (
      <InlineSessionError
        title={formatted.title}
        message={formatted.message}
        detail={restart.errorMessage ?? formatted.detail}
        action={<RestartSessionButton restart={restart} onRestart={restart.restart} />}
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
      {/* A crash in the chat is a RESOLUTION of this layer, and the route has to
          hear about it. `onChatReady` is otherwise the only thing that lowers
          the boot overlay, and it is reported by `SessionChat` itself — so a
          `SessionChat` that throws could never report it, and the overlay stayed
          at full opacity forever with its 1s boot clock still ticking. The user
          got a permanent "Connecting" spinner over a crash that had already
          happened, and no way out but a page reload. */}
      <ClientErrorBoundary
        fallback={({ error, reset }) => (
          <SessionChatCrashCard error={error} reset={reset} onSettled={onChatReady} />
        )}
      >
        <SessionChat
          key={chatSessionId}
          sessionId={chatSessionId}
          projectSessionId={sessionId}
          projectId={projectId}
          boundAgentName={boundAgentName}
          onContentReady={onChatReady}
          deferComposerFocus={!chatReady}
          sessionState={chatSessionId === sessionState.opencodeSessionId ? sessionState : undefined}
        />
      </ClientErrorBoundary>
    </SessionLayout>
  );
}

/**
 * The chat's crash card, plus the one thing the card alone cannot say: this
 * layer is done resolving, so stop covering it.
 *
 * `onSettled` fires in an effect rather than during render because it drives a
 * `setState` in the route above — calling it while rendering the fallback would
 * be a render-phase update of a different component.
 *
 * It deliberately does NOT reset itself: the boundary keeps the error until the
 * user chooses. `reset()` remounts `SessionChat`, which then reports readiness
 * again through its own path.
 */
function SessionChatCrashCard({
  error,
  reset,
  onSettled,
}: {
  error: Error;
  reset: () => void;
  onSettled?: () => void;
}) {
  useEffect(() => {
    onSettled?.();
  }, [onSettled]);
  return <AppErrorCard error={error} reset={reset} />;
}
