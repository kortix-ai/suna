'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { canMountSessionChat } from '@/features/session/session-load-state';
import { isFirstPromptRow } from '@/features/session/queue-projection';
import {
  hasOrExpectsTranscript,
  resolveBootPresentation,
  resolveResumeOverlay,
  resolveSessionOverlay,
  shouldForgetNewSessionHint,
  shouldMountSessionChat,
} from '@/features/session/session-surface';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import { clearSessionFresh, isSessionFresh } from '@kortix/sdk';
import { type UseSessionResult, readStartStash, useSessionPrompts } from '@kortix/sdk/react';

// `useLayoutEffect` warns in a server render, where it cannot run anyway.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * The session route's crossfade and first-prompt hand-off state, lifted out of
 * the route verbatim.
 *
 * It owns: the chat-ready/loader pair the overlay dissolves through (chat
 * reported ready, or boot status moved into the banner), the hand-off seeded
 * once at mount from every producer's stash, the durable-inbox restore of a
 * first prompt after a reload, and the transcript-evidence latch that keeps a
 * stale hint from stranding a real session on the empty new-session surface.
 *
 * From these it derives the overlay presentation (`overlay`,
 * `bootPresentation`, `overlayDismissed`) and the surface facts the route
 * mounts the chat from (`surface`, `shellSubmitted`). The dismissal effects —
 * the belt-and-braces unmount timer and the painted-once layout effect — live
 * here too, because they drive exactly this state.
 */
export function useSessionCrossfade({
  projectId,
  sessionId,
  hasUser,
  session,
}: {
  projectId: string;
  sessionId: string;
  hasUser: boolean;
  session: UseSessionResult;
}) {
  // ── Crossfade: the overlay fades out as the real chat fades in ────────────
  // The overlay (a fully-interactive new-session shell, or the boot loader for a
  // resume) occupies a SINGLE stable tree position for the whole pre-ready
  // lifecycle, so nothing under it remounts as the boot advances.
  const [chatReady, setChatReady] = useState(false);
  // Stable: it rides an effect dependency inside SessionChat, and a fresh arrow
  // every render would re-run that effect on every render of this route.
  const handleChatReady = useCallback(() => setChatReady(true), []);
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
  const [restoredFirstPrompt, setRestoredFirstPrompt] = useState(false);
  // A reload has no local handoff. Restore the typing surface from the same
  // durable inbox the shell reads, then let the shell own further polling.
  const restoreInbox = useSessionPrompts(projectId, sessionId, {
    enabled: hasUser && !chatReady && !handoff.newSessionHint && !restoredFirstPrompt,
  });
  const hasPendingFirstPrompt = restoreInbox.prompts.some(isFirstPromptRow);
  useEffect(() => {
    if (hasPendingFirstPrompt && session.messages.length === 0) setRestoredFirstPrompt(true);
  }, [hasPendingFirstPrompt, session.messages.length]);
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
  const shellShowsFirstPrompt =
    submittedOnShell || hasFirstPromptPreview || handoff.firstPrompt || restoredFirstPrompt;
  // Mounting the chat takes the same evidence plus one weaker source: a stashed
  // prompt means the message is committed and needs a runtime, so the chat
  // should be warming up. It does NOT pin the shell — a stash can outlive the
  // hand-off it describes, and a stale one must not hold a real session on a
  // bubble it no longer owns.
  const shellSubmitted = handoff.pending || shellShowsFirstPrompt;

  // Transcript evidence — the veto that keeps a stale hint from stranding a real
  // session on the empty new-session surface. It comes from `useSession`'s own
  // sync, which paints the saved copy (the one this device kept, then the
  // server's) WITHOUT waiting for the sandbox, so it lands while a hibernated
  // box is still waking and without the chat having mounted. Latched: the store only ever grows for a live session,
  // but a transient empty read must never resurrect the shell.
  const [sawTranscript, setSawTranscript] = useState(false);
  useEffect(() => {
    if (session.messages.length > 0) setSawTranscript(true);
  }, [session.messages.length]);
  const hasTranscript = session.messages.length > 0 || sawTranscript;

  const surface = {
    newSessionHint: handoff.newSessionHint,
    hasTranscript,
    hasPendingFirstPrompt,
    conversationEmpty: session.conversationEmpty,
  };
  const overlay = resolveSessionOverlay({ ...surface, shellShowsFirstPrompt });
  // WHICH overlay is settled above; this decides whether it may COVER the chat.
  //
  // It may not, once there is a transcript under it. The server-side transcript
  // mirror (`GET …/transcript?shape=sync`, hydrated by the SDK with
  // `source: 'cache'`) means a hibernated session paints its history on the
  // first frame, so a full-screen "Connecting…" would now be hiding a readable
  // conversation for the length of the wake — 5-240 s, the exact complaint.
  // Boot status becomes a compact banner above the thread instead.
  const bootPresentation = resolveBootPresentation({ overlay, hasTranscript });

  // The overlay is DISMISSED for two reasons now, and both use the same 300ms
  // crossfade the chat layer was already painted underneath: the chat reported
  // ready, or the transcript arrived and boot status moved into the banner.
  // Reusing the fade is deliberate — flipping the presentation with a hard
  // unmount would swap an opaque panel for the thread in one frame.
  const overlayDismissed = chatReady || bootPresentation === 'banner';
  // Belt and braces for the `onTransitionEnd` unmount below: `transitionend`
  // never fires when the tab is backgrounded mid-fade, nor under
  // `prefers-reduced-motion` where the duration is 0. Without this the loader
  // subtree — including its 1s boot-clock interval — stays mounted behind
  // `opacity-0` for the rest of the session.
  //
  // Armed on the DISMISSAL SIGNAL, so ONE timer covers both reasons the overlay
  // dissolves — the chat reporting ready, or the transcript arriving and boot
  // status moving into the banner. Two timers used to exist, one per reason,
  // because the first was not re-armed when the overlay was dismissed later;
  // depending on the signal itself makes the second redundant.
  useEffect(() => {
    if (!overlayDismissed || !loaderMounted) return;
    const t = setTimeout(() => setLoaderMounted(false), 350);
    return () => clearTimeout(t);
  }, [overlayDismissed, loaderMounted]);

  // An overlay dismissed before it was ever painted leaves at once, with no
  // fade. A reopened session paints the saved copy this device kept in a
  // layout effect, so its overlay is dismissed inside the first commit — and
  // the 300ms fade then showed skeleton rows dissolving over a conversation
  // that was already there (journey 34's recording). A fade is for something
  // the user saw. The second frame callback runs after the first paint.
  const overlayPaintedRef = useRef(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        overlayPaintedRef.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  useIsomorphicLayoutEffect(() => {
    if (overlayDismissed && loaderMounted && !overlayPaintedRef.current) setLoaderMounted(false);
  }, [overlayDismissed, loaderMounted]);

  // And for a session being RESUMED, which surface stands in for the chat:
  // skeleton rows while its saved conversation is on its way (one round trip
  // to the control plane), the boot screen only when there is nothing saved to
  // read. See `useSession().savedTranscript`.
  const resumeOverlay = resolveResumeOverlay({ savedTranscript: session.savedTranscript });
  const expectsTranscript = hasOrExpectsTranscript({
    hasTranscript,
    savedTranscript: session.savedTranscript,
  });

  // Existing sessions can mount from their server-owned pin before the runtime
  // switch completes; `useSessionSync` then fills the transcript from the live
  // runtime once useSession finishes the switch.
  //
  // The transcript paints before the sandbox answers from the SAVED COPY: the
  // one this device kept from its last open, then the server's, which the API
  // writes because a turn ended (`use-session-sync.ts`). The old IndexedDB
  // mirror of the live store was removed because it could not see a turn
  // ending; a server capture cannot get that wrong.
  const sessionContentAvailable = canMountSessionChat({
    switched: session.switched,
    runtimeSessionId: session.runtimeSessionId,
  });
  // For a genuinely new session, hold the real chat until the user actually sends
  // their first message — the instant shell is the typing surface until then, and
  // a second composer underneath it would fight for focus. `shouldMountSessionChat`
  // owns the rule that makes that hold safe: transcript evidence outranks the
  // hint, so a session with history is never held back (session-surface.ts).
  const mountChat = shouldMountSessionChat({
    ...surface,
    contentAvailable: sessionContentAvailable,
    submitted: shellSubmitted,
  });

  // Drop the local hint as soon as it has done its job OR been proven wrong.
  // This used to wait on `chatReady`, which the hint itself could withhold — so
  // a wrong hint kept itself alive for the whole tab.
  useEffect(() => {
    if (shouldForgetNewSessionHint({ chatReady, hasTranscript, submitted: shellSubmitted })) {
      clearSessionFresh(sessionId);
    }
  }, [chatReady, hasTranscript, shellSubmitted, sessionId]);

  return {
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
  };
}
