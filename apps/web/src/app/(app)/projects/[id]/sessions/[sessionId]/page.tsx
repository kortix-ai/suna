'use client';

import { useTranslations } from 'next-intl';

import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import { isLegacyMigratedSession, sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import { resolvePinnedRootSessionId } from '@/features/session/pinned-root-session';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import { ProviderFailureRecovery } from '@/features/session/provider-failure-recovery';
import {
  pendingSessionPromptForRecovery,
  provisioningFailurePresentation,
  startStashFromPendingSessionPrompt,
} from '@/features/session/provisioning-failure';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
import { SessionChat } from '@/features/session/session-chat';
import { SessionLayout } from '@/features/session/session-layout';
import {
  canMountSessionChat,
  canShowSessionChat,
  findInitialSessionPin,
  gatedRuntimeError,
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
import {
  shouldShowSessionSwitchLoading,
  useSessionSwitchStore,
} from '@/stores/session-switch-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import {
  type ProjectSession,
  formatRuntimeError,
  getProjectDetail,
  listProjectSessions,
  sessionStartKey,
} from '@kortix/sdk';
import { clearSessionFresh, isSessionFresh } from '@kortix/sdk/fresh-sessions';
import { setActiveInstanceCookie } from '@kortix/sdk/instance-routes';
import {
  type UseSessionResult,
  contract,
  migrateStash,
  qk,
  readStartStash,
  useRuntimeConnectionStore,
  useSession,
  writeStartStash,
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
  const pendingPrompt = pendingSessionPromptForRecovery(
    sessionId,
    currentProjectSession?.metadata,
  );
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
    if (pendingPrompt) {
      writeStartStash(sessionId, startStashFromPendingSessionPrompt(pendingPrompt));
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
  const [loaderMounted, setLoaderMounted] = useState(true);
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
    if (typeof window === 'undefined') return { pending: false, newSessionHint: false };
    const pending = !!readStartStash(sessionId)?.prompt;
    return { pending, newSessionHint: pending || isSessionFresh(sessionId) };
  });
  const [submittedOnShell, setSubmittedOnShell] = useState(false);
  // Arriving with a stashed prompt counts as submitted for the purpose of
  // mounting the chat (the message is already committed and needs a runtime to
  // send it), but NOT for holding the shell in place — a stash can outlive the
  // hand-off it describes, and only a send made HERE means the user is watching
  // their own optimistic bubble on this shell.
  const shellSubmitted = handoff.pending || submittedOnShell;

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
  const overlay = resolveSessionOverlay({ ...surface, submittedOnShell });

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
  // Sending still waits on the runtime — `sessionComposerReadiness` /
  // `canDrainQueue`'s `runtimeReady` gate (unchanged) queue a submit instead
  // of dropping it, and show their own "waking" notice above the composer.
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
              'absolute inset-0 flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-300 ease-out',
              chatReady ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <ProjectSessionRuntimeConnection>
              {mountChat && (
                <ActiveSessionChat
                  projectId={projectId}
                  sessionId={sessionId}
                  sessionState={session}
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
            {overlay === 'new-session-shell' ? (
              <InstantSessionShell
                projectId={projectId}
                sessionId={sessionId}
                stage={authLoading || !user ? 'provisioning' : startStage}
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
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h2 className="text-foreground/90 text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground/70 text-xs leading-relaxed">{message}</p>
        {detail ? (
          <p className="border-border/60 bg-muted/40 text-muted-foreground max-w-full rounded-md border px-2 py-1 font-mono text-xs leading-relaxed">
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
 * `useSession` owns the canonical runtime session and the optional REST session
 * list used by legacy `?oc` deep links.
 */
function ActiveSessionChat({
  projectId,
  sessionId,
  sessionState,
  onChatReady,
}: {
  projectId: string;
  sessionId: string;
  sessionState: UseSessionResult;
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
  // the panic card — and marked `chatShowable` below true, ending the loading
  // skeleton with nothing to show — for every such race; `phase === 'error'`
  // is the SDK's own answer to "is this real." `canShowSessionChat` below
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
    // Same hand-off for the message queue: the instant shell enqueues under
    // the ROUTE id, SessionChat drains under the pin — see adoptSessionQueue.
    useMessageQueueStore.getState().adoptSessionQueue(sessionId, chatSessionId);
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

  const chatShowable = canShowSessionChat({
    chatSessionId,
    runtimeError,
    runtimeBootError,
  });
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
        detail={restart.errorMessage ?? runtimeBootError}
        action={<RestartSessionButton restart={restart} onRestart={restart.restart} />}
      />
    );
  }

  if (runtimeError) {
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
      <ClientErrorBoundary>
        <SessionChat
          key={chatSessionId}
          sessionId={chatSessionId}
          projectSessionId={sessionId}
          projectId={projectId}
          sessionState={chatSessionId === sessionState.opencodeSessionId ? sessionState : undefined}
        />
      </ClientErrorBoundary>
    </SessionLayout>
  );
}
