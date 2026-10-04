'use client';

import { useTranslations } from '@/i18n/use-translations';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { isLegacyMigratedSession, sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { InstantSessionShell } from '@/features/session/instant-session-shell';
import {
  PreviousRepositoryNoticeProvider,
  sessionUsesPreviousRepository,
} from '@/features/session/previous-repository-session';
import { ProviderFailureRecovery } from '@/features/session/provider-failure-recovery';
import {
  pendingSessionPromptForRecovery,
  provisioningFailurePresentation,
} from '@/features/session/provisioning-failure';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
import { SavedSessionSkeleton } from '@/features/session/saved-session-skeleton';
import { useSessionAudit } from '@/features/session/session-audit-shared';
import '@/features/session/tool/tools/register';
import { findInitialSessionPin } from '@/features/session/session-load-state';
import {
  SessionNotice,
  SessionNoticeBanner,
  type SessionNoticeProps,
} from '@/features/session/session-notice-banner';
import { isRuntimeIdentityUnavailable } from '@/features/session/session-resume';
import { canPollSessionStart } from '@/features/session/session-start-gate';
import {
  SessionConnectingBanner,
  SessionStartingLoader,
} from '@/features/session/session-starting-loader';
import {
  canRenderCachedTranscriptWhileSandboxDown,
  isDormantSessionWithoutRuntime,
  isUnmaterializedSessionFailure,
} from '@/features/session/session-terminal-state';
import {
  shouldPaintFatalCard,
  shouldPaintTerminalCard,
} from '@/features/session/terminal-card-gate';
import { useSessionCrossfade } from '@/features/session/use-session-crossfade';
import { useSessionWakeLadder } from '@/features/session/use-session-wake-ladder';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { useAccountState } from '@/hooks/billing';
import {
  billingDialogArgs,
  billingGateCopy,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { sessionMark } from '@/lib/session-timing';
import { cn } from '@/lib/utils';
import {
  shouldShowSessionSwitchLoading,
  useSessionSwitchStore,
} from '@/stores/session-switch-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getProjectDetail, setActiveInstanceCookie, updateProjectSession } from '@kortix/sdk';
import {
  clearStartStash,
  contract,
  qk,
  readStartStash,
  startSessionWithPrompt,
  useProjectSession,
  useSession,
} from '@kortix/sdk/react';

import { ActiveSessionChat } from './active-session-chat';
import {
  HeaderlessSessionSurface,
  InlineSessionError,
  ProjectSessionRuntimeConnection,
  RestartSessionButton,
  presentTerminal,
} from './session-route-cards';

/**
 * /projects/[id]/sessions/[sessionId] — project-scoped session view.
 *
 * The entire runtime lifecycle (POST /start, the sandbox switch, the SSE stream,
 * readiness seeding, and the canonical OpenCode pin) is owned by the SDK's
 * `useSession` hook; the wake/auto-resume ladder and the crossfade + first-prompt
 * hand-off live in their own hooks beside this route, and the terminal/restart
 * cards in `session-route-cards.tsx`. Readiness is server-truth (`/start`
 * `stage==='ready'`, seeded by useSession into the connection store); the local
 * `useSandboxConnection` poller stays mounted for MID-SESSION reconnect
 * detection only. The URL stays at `/projects/<id>/sessions/<sessionId>` throughout.
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Stable route-level owner. Runtime identity handoffs remount the chat, so a
  // poll timer inside chat produces overlapping audit schedules.
  useSessionAudit(projectId, sessionId, { poll: true, silent: true, limit: 100 });
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tSessionPage = useTranslations('sessionPage');
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
  // This page needs exactly ONE session — its own. It used to find that row by
  // scanning the project's whole session list, which was never the right read
  // and became a wrong one once that list became a bounded page: a session
  // older than the first page is absent from it, so the page would have opened
  // with no pin, no agent name and no recovery metadata. `useProjectSession`
  // reads the row by id, which is exact at any age, costs one indexed lookup
  // instead of a page scan, and returns `metadata` WHOLE where the list
  // deliberately trims its heavy write-only keys (`trimListMetadata`).
  const { data: currentProjectSession } = useProjectSession(projectId, sessionId, {
    enabled: !!user && !!projectId,
  });
  const pendingPrompt = pendingSessionPromptForRecovery(sessionId, currentProjectSession?.metadata);
  const initialRuntimeSessionId = findInitialSessionPin(currentProjectSession);

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
    browserPresence: !!user,
    enabled: canPollSessionStart({ hasUser: !!user, billingBlocked }),
    replayStartStash: false,
    initialRuntimeSessionId,
    // This view renders lifecycle UI around the transcript. `SessionChat`
    // reads the live rows itself (`useSessionMessages`), so a streamed delta
    // re-renders the transcript only, not this whole page.
    subscribeMessages: false,
  });
  // `/start` no longer refuses a session created before a repository
  // replacement, so there is no error to detect and no mode to flip into: the
  // session starts, gets the project's current config release, and converges
  // like any other. What is still true is that its clone came from the old
  // repository — which is what the notice below is for.
  const usesPreviousRepository = sessionUsesPreviousRepository(
    projectDetail?.project.metadata,
    currentProjectSession?.metadata,
  );
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

  // The wake/auto-resume ladder and the route's ONE restart behavior, owned by
  // the hook — see `useSessionWakeLadder`.
  const { restart, handleRestart, wake, autoResuming, wakeLadderHolding } = useSessionWakeLadder({
    session,
    authLoading,
    hasUser: !!user,
    billingBlocked,
    projectId,
    sessionId,
    queryClient,
  });
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
          errorToast(
            error instanceof Error
              ? error.message
              : tI18nHardcoded.raw('i18nComplete.text4778a1377329'),
          );
        });
    }
    handleRestart();
  };
  const copyPendingPrompt = async () => {
    if (!pendingPrompt) {
      errorToast(tI18nHardcoded.raw('i18nComplete.text7ea05ee375a0'));
      return;
    }
    try {
      await navigator.clipboard.writeText(pendingPrompt.text);
      successToast(tI18nHardcoded.raw('i18nComplete.text42cc4740d3d5'));
    } catch {
      errorToast(tI18nHardcoded.raw('i18nComplete.text231082dfe1a4'));
    }
  };
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
    openUpgradeDialog(
      billingDialogArgs(billingState, accountState, projectAccountId, tI18nComplete),
    );
  }, [
    billingBlocked,
    billingState,
    accountState,
    openUpgradeDialog,
    projectAccountId,
    tI18nComplete,
  ]);

  // The crossfade and the first-prompt hand-off state, owned by the hook —
  // see `useSessionCrossfade`.
  const {
    chatReady,
    handleChatReady,
    loaderMounted,
    setLoaderMounted,
    overlayDismissed,
    overlay,
    bootPresentation,
    surface,
    shellSubmitted,
    hasTranscript,
    sessionContentAvailable,
    mountChat,
    resumeOverlay,
    expectsTranscript,
    setSubmittedOnShell,
  } = useSessionCrossfade({ projectId, sessionId, hasUser: !!user, session });
  // A session whose clone predates a repository replacement still has its
  // transcript. Do not replace a readable conversation with a failure card.
  const previousRepositoryHistoryAvailable = hasTranscript && usesPreviousRepository;
  const resumeSkeleton = (
    <SavedSessionSkeleton
      projectId={projectId}
      sessionId={sessionId}
      stage={authLoading || !user ? 'provisioning' : startStage}
    />
  );

  // Terminal/gated states fully REPLACE the content (no chat to fade to).
  const gated = !authLoading && !!user && billingBlocked;
  const fatal =
    !authLoading &&
    !!user &&
    !!sandbox &&
    (sandbox.status === 'error' || sandbox.status === 'stopped') &&
    // See `shouldPaintFatalCard`: gates on `stage` ALONE -- neither `retriable`
    // (a stale-wake PARK answers `stage:'failed', retriable:true` and must
    // still paint) nor `activelyStarting` (`stage:'failed'` is reachable with
    // `actively_starting:true` via a detached wake-fence race, and nothing
    // else polls or re-invalidates a `failed` session to recover the user).
    shouldPaintFatalCard({ stage: session.stage });
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
    // A saved copy still on its way counts too: for its one round trip the
    // overlay shows skeleton rows, and only once it answers `none` do the
    // restart card and the waking screen below get their turn.
    hasCachedContent: expectsTranscript,
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
    !previousRepositoryHistoryAvailable &&
    !authLoading &&
    !!user &&
    isUnmaterializedSessionFailure(terminalState);
  const dormantWithoutRuntime =
    !previousRepositoryHistoryAvailable &&
    !authLoading &&
    !!user &&
    isDormantSessionWithoutRuntime(terminalState);
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
    // `session.failure` is the ONE branch here the server can answer while
    // still retrying — e.g. `{stage:'starting', retriable:true,
    // failure:{...}}` for a wake cooldown. Gate it on `retriable`/
    // `activelyStarting`; the other branches below (`sandbox.status ===
    // 'error'`, `unmaterializedFailure`, `session.startError`) are already
    // hard-terminal signals (`isUnmaterializedSessionFailure` already reads
    // `retriable` itself) and stay as they are.
    if (
      session.failure &&
      shouldPaintTerminalCard({
        hasFailure: true,
        retriable: session.retriable,
        activelyStarting: session.activelyStarting,
      })
    ) {
      return provisioningFailurePresentation(
        {
          ...metadata,
          failureCategory: session.failure.category,
          errorMessage: session.failure.message,
        },
        sandboxLabel ?? 'session',
        tI18nComplete,
      );
    }
    if (sandbox?.status === 'error') {
      return provisioningFailurePresentation(metadata, sandboxLabel ?? 'session', tI18nComplete);
    }
    if (unmaterializedFailure) {
      return provisioningFailurePresentation({}, sandboxLabel ?? 'session', tI18nComplete);
    }
    if (session.startError) {
      return provisioningFailurePresentation(
        {
          failureCategory: 'sandbox-provider',
          errorMessage: session.startError.message,
        },
        sandboxLabel ?? 'session',
        tI18nComplete,
      );
    }
    return null;
  })();
  const inner = (() => {
    if (sessionSwitchLoading) {
      if (resumeOverlay === 'saved-skeleton') return resumeSkeleton;
      return (
        <HeaderlessSessionSurface>
          <SessionStartingLoader
            stage={switchingToSessionId === sessionId ? startStage : 'starting'}
            projectId={projectId}
            sessionId={switchingToSessionId ?? sessionId}
            reason={switchingToSessionId === sessionId ? session.reason : null}
            failure={switchingToSessionId === sessionId ? session.failure : null}
          />
        </HeaderlessSessionSurface>
      );
    }

    if (gated) {
      const blockedState =
        billingState && billingState !== 'active' ? billingState : 'no_subscription';
      const copy = billingGateCopy(blockedState, tI18nComplete);
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
                openUpgradeDialog(
                  billingDialogArgs(billingState, accountState, projectAccountId, tI18nComplete),
                )
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
          title={tSessionPage('missing.title')}
          message={tSessionPage('missing.message')}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}`} prefetch>
                {tSessionPage('backToProject')}
              </Link>
            </Button>
          }
        />
      );
    }

    // A readable conversation is never replaced by a card. With a transcript
    // on screen — and the saved copy paints one before the computer answers —
    // each terminal state below becomes a notice in the COMPOSER'S SLOT, with
    // the same words and the same action: nothing can be sent, and nothing
    // covers the thread. The full-screen card is kept for a session with
    // nothing to read.
    let notice: SessionNoticeProps | null = null;

    // The wake ladder is still working: a session with rungs left is not a dead
    // end, and painting one is the exact defect this replaces — the card fired
    // while the box was seconds from ready. The transcript mirror keeps
    // rendering underneath when there is one (`showCachedTranscriptWhileDown`),
    // so falling through here costs the user nothing.
    if (wakeLadderHolding) {
      if (!showCachedTranscriptWhileDown) {
        return (
          <HeaderlessSessionSurface>
            <SessionStartingLoader
              stage="starting"
              projectId={projectId}
              sessionId={sessionId}
              note={wake.note}
              reason={session.reason}
              failure={session.failure}
            />
          </HeaderlessSessionSurface>
        );
      }
    } else if (recoverableFailure) {
      // A dead end that cannot say what was already attempted invites the
      // user to repeat it by hand. `wake.summary` names every rung the ladder
      // used before giving up. It rides in the MESSAGE, not in `detail`: that
      // slot is monospace, for provider ids and raw errors, and a sentence in
      // it wraps mid-word.
      const failureMessage = wake.summary
        ? `${recoverableFailure.message} ${wake.summary}`
        : recoverableFailure.message;
      const failureRecovery = (
        <ProviderFailureRecovery
          pendingPrompt={pendingPrompt}
          isRetrying={restart.isPending}
          onRetry={handleProvisioningRetry}
          onCopy={() => void copyPendingPrompt()}
          onDelete={() => setDeleteOpen(true)}
        />
      );
      const terminal = presentTerminal({
        hasTranscript,
        title: recoverableFailure.title,
        message: failureMessage,
        noticeMessage: restart.errorMessage ?? failureMessage,
        detail: restart.errorMessage ?? undefined,
        action: failureRecovery,
        tone: 'destructive',
      });
      if (terminal.fullScreen) return terminal.fullScreen;
      notice = terminal.notice;
    }

    // Stopped, with no sandbox row to describe — the `fatal` branch below reads
    // `sandbox.status`, which does not exist here, so this state used to fall
    // into the FAILURE card above and claim a session that merely stopped had
    // failed before it ever got a computer.
    if (!notice && dormantWithoutRuntime) {
      // A migrated session's first open lands here by design: it has never had
      // a computer. "Stopped" would be a lie — nothing ever ran. Say what it is
      // and make the CTA the restore it actually performs.
      if (currentProjectSession && isLegacyMigratedSession(currentProjectSession)) {
        const restoreAction = (
          <RestartSessionButton
            restart={restart}
            onRestart={handleRestart}
            label={tSessionPage('legacy.restore')}
            pendingLabel={tSessionPage('legacy.restoring')}
          />
        );
        const terminal = presentTerminal({
          hasTranscript,
          title: tSessionPage('legacy.title'),
          message: tSessionPage('legacy.message'),
          noticeMessage: restart.errorMessage ?? tSessionPage('legacy.message'),
          detail: restart.errorMessage ?? undefined,
          action: restoreAction,
        });
        if (terminal.fullScreen) return terminal.fullScreen;
        notice = terminal.notice;
      } else {
        const terminal = presentTerminal({
          hasTranscript,
          title: tSessionPage('stopped.title'),
          message: tSessionPage('stopped.message'),
          noticeMessage: restart.errorMessage ?? tSessionPage('stopped.message'),
          detail: restart.errorMessage ?? undefined,
          action: <RestartSessionButton restart={restart} onRestart={handleRestart} />,
        });
        if (terminal.fullScreen) return terminal.fullScreen;
        notice = terminal.notice;
      }
    }

    // The provider lost this session's computer. THIS MUST NEVER HAPPEN, and
    // when it does the only honest UI is a hard stop: nothing here is
    // restartable (`/start` answers `retriable: false`, `POST /restart` answers
    // 409 forever), and this session cannot be reconstructed.
    //
    // It must NOT fall through to the generic stopped card below, which offers
    // a Restart button whose only possible outcome is that 409 — the loop a prod
    // session hit on 2026-08-13. It must also NEVER silently continue
    // into a fresh session: the server deliberately preserved this identity
    // instead of attaching a replacement box, and the UI must not undo that.
    // Say what happened, name the id, and stop.
    if (!notice && runtimeIdentityUnavailable && !previousRepositoryHistoryAvailable) {
      const deleteAction = (
        <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
          {tSessionPage('delete')}
        </Button>
      );
      // The conversation stays readable: nothing can continue it, but nothing
      // about losing the computer made its history untrue.
      const terminal = presentTerminal({
        hasTranscript,
        title: tSessionPage('lost.title'),
        message: tSessionPage('lost.message'),
        noticeMessage: tSessionPage('lost.message'),
        detail: sandbox?.external_id ? `${sandbox.provider} · ${sandbox.external_id}` : undefined,
        action: deleteAction,
        tone: 'destructive',
      });
      if (terminal.fullScreen) return terminal.fullScreen;
      notice = terminal.notice;
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
          <HeaderlessSessionSurface>
            <SessionStartingLoader
              stage="starting"
              projectId={projectId}
              sessionId={sessionId}
              note={wake.note}
              reason={session.reason}
              failure={session.failure}
            />
          </HeaderlessSessionSurface>
        );
      }
      // Auto-resume exhausted (or genuinely un-resumable): give an in-place
      // Restart instead of forcing a manual browser refresh.
      return (
        <InlineSessionError
          title={tI18nComplete('textb13c564cdf28', { value0: sandboxLabel ?? 'session' })}
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
        {sessionContentAvailable && (
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
            aria-hidden={!overlayDismissed}
            inert={!overlayDismissed}
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
                  // A terminal state under a banner: the banner names the reason
                  // and the one action. A composer beside it would promise that
                  // the next message wakes a computer that cannot come back.
                  readOnly={!!notice}
                  inputReplacement={notice ? <SessionNotice {...notice} /> : undefined}
                />
              )}
            </ProjectSessionRuntimeConnection>
          </div>
        )}

        {loaderMounted && (
          <div
            aria-hidden={overlayDismissed}
            inert={overlayDismissed}
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
              'bg-background absolute inset-0 flex flex-col transition-opacity duration-slow ease-out',
              overlayDismissed ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            {overlay === 'new-session-shell' ? (
              <InstantSessionShell
                projectId={projectId}
                sessionId={sessionId}
                stage={authLoading || !user ? 'provisioning' : startStage}
                boundAgentName={boundAgentName}
                onSubmit={() => setSubmittedOnShell(true)}
                // The chat underneath owns the prompt from here; the shell's
                // copy would otherwise dissolve over it for the whole fade.
                hasTranscript={hasTranscript}
                draftActive={!overlayDismissed}
              />
            ) : resumeOverlay === 'saved-skeleton' ? (
              resumeSkeleton
            ) : (
              <HeaderlessSessionSurface>
                <SessionStartingLoader
                  stage={authLoading || !user ? 'provisioning' : startStage}
                  projectId={projectId}
                  sessionId={sessionId}
                  note={wake.note}
                  reason={session.reason}
                  failure={session.failure}
                />
              </HeaderlessSessionSurface>
            )}
          </div>
        )}

        {/* Boot status ABOVE the conversation, never in front of it. Mounted
            only in the `banner` presentation — i.e. only when there is a
            transcript underneath worth reading — and held until the runtime is
            actually reachable, so the strip does not disappear the instant the
            chat paints while the box is still coming up. What SENDING will do
            during the wake is the composer's own notice; this says only which
            phase the boot is in. */}
        {notice && !sessionContentAvailable ? <SessionNoticeBanner {...notice} /> : null}
        {!notice && bootPresentation === 'banner' && (startStage !== 'ready' || !chatReady) && (
          <SessionConnectingBanner
            stage={authLoading || !user ? 'provisioning' : startStage}
            projectId={projectId}
            sessionId={sessionId}
            note={wake.note}
            reason={session.reason}
            failure={session.failure}
          />
        )}
      </div>
    );
  })();

  return (
    <>
      <SandboxLoadingBoundary>
        {/* The notice itself mounts in the session header, which owns its
            position; the route only decides whether this session needs it. */}
        <PreviousRepositoryNoticeProvider value={usesPreviousRepository}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{inner}</div>
        </PreviousRepositoryNoticeProvider>
      </SandboxLoadingBoundary>
      <SessionDeleteModal
        projectId={projectId}
        sessionId={sessionId}
        sessionLabel={
          currentProjectSession
            ? sessionDisplayLabel(currentProjectSession)
            : tSessionPage('failedLabel')
        }
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(`/projects/${projectId}`)}
      />
    </>
  );
}
