/**
 * One user action = one submission — without eating the NEXT user action, and
 * without MERGING the next actions into one.
 *
 * Why a latch exists at all: the sandbox proxy used to absorb an accidental
 * double-fire for free by deduping deliveries on a body hash; per-submission
 * `messageID`s deliberately ended that (the same mechanism swallowed prompts a
 * user MEANT to send twice), leaving the accidental case with nothing behind
 * it. `dispatchSubmission` clears the editor synchronously before it awaits,
 * which stops a repeat of the TEXT — but `setAttachedFiles([])` is React state
 * and has not flushed, so a second Enter in the same tick could still pass the
 * empty-draft guard on `attachedFiles.length > 0` and post an empty message
 * carrying the files.
 *
 * Why it is THIS latch and not `if (inFlight) return;`: the dispatch it guards
 * awaits the previous send's ACK, and that ACK is not instant — file uploads,
 * plus `promptOpenCodeMessage`'s transient-failure retries with a ~30s
 * boot/wake window for a sleeping sandbox, and an API under load (measured
 * 9 s for one `POST .../prompts`). A blanket return held the gate for that
 * entire window and silently dropped every submission inside it, so the
 * second message a user typed right after the first NEVER reached the
 * busy→queue decision the composer owns. The queue existed precisely for that
 * message, and the latch stood in front of it.
 *
 * The two cases are distinguishable at the moment the re-entrant submit
 * arrives:
 *
 *  - **Double-fire** (the hazard the latch is for): the editor is already
 *    empty — dispatch cleared it synchronously. Dropped, as before.
 *  - **Distinct message**: the user typed new text. STASHED — captured out of
 *    the editor (which is cleared, exactly as a dispatch would clear it) into a
 *    FIFO, and dispatched in order once the in-flight dispatch settles. By
 *    then the session's optimistic busy status is set, so each stashed draft
 *    routes into the message queue rather than double-sending.
 *
 * Stashing, not collapsing. The previous version deferred ONE re-run that
 * re-read the live editor, "which already contains everything the user
 * typed" — so three Enters during one slow ACK became ONE message with the
 * three texts run together ("say ALPHA only.Queued #2: then say BETA only."),
 * measured live (queue-lab `queue3` on a cold box, 2026-08-19). Every Enter is
 * one message; the order is the order the user pressed Enter.
 *
 * Framework-free on purpose so the ordering is unit-testable with real
 * promises instead of source-text assertions.
 */
export function createSubmitLatch<Draft, Intent = void>(
  /**
   * Run one submission. With no draft: read the live editor, as a direct
   * submit always has. With a stashed draft: submit THAT, the editor having
   * been cleared at stash time. `intent` is the one the submission was made
   * with — never the latest one, see below.
   */
  dispatch: (stashed: Draft | undefined, intent: Intent) => Promise<void>,
  /**
   * Capture the CURRENT draft as its own submission — and clear it from the
   * editor — or return null when there is nothing distinct to submit (a
   * cleared editor: the double-fire). Read at re-entrant-submit time, and told
   * which intent it is capturing so the draft can carry it.
   */
  stashDeferrableDraft: (intent: Intent) => Draft | null,
): (intent: Intent) => Promise<void> {
  let inFlight = false;
  // THE INTENT IS STASHED WITH ITS DRAFT, not read again at dispatch time.
  //
  // Enter sends the prompt — never interrupting; the server holds it until the
  // running turn ends — and Cmd+Enter PARKS it, held until the user releases
  // it. Those are opposite answers to "does this run on its own?", so a stashed
  // prompt must be dispatched with the intent its own keypress carried.
  // Re-deriving it later (from the newest submit, or from whether the session
  // is busy by then) sends a prompt the user deliberately set aside, one
  // keystroke after they chose to set it aside.
  const stashed: Array<{ draft: Draft; intent: Intent }> = [];

  const run = async (draft: Draft | undefined, intent: Intent): Promise<void> => {
    inFlight = true;
    try {
      await dispatch(draft, intent);
    } finally {
      // Everything stashed while this dispatch was in flight goes out NOW,
      // TOGETHER. The dispatches are invoked in stash order — their
      // synchronous prefixes (wire-id mint, optimistic paint) run in that
      // order, which is what display and the server's `client_sent_at_ms`
      // key on — but their awaits (uploads, the POST) run concurrently: one
      // slow ack must not hold the rest of a burst back one round-trip each,
      // or the server's batch closes before the burst is even durable.
      const burst = stashed.splice(0);
      if (burst.length > 0) {
        void Promise.allSettled(burst.map((next) => dispatch(next.draft, next.intent))).finally(
          () => {
            inFlight = false;
            const late = stashed.splice(0);
            if (late.length > 0) {
              void Promise.allSettled(late.map((next) => dispatch(next.draft, next.intent)));
            }
          },
        );
        return;
      }
      inFlight = false;
    }
  };

  return (intent: Intent): Promise<void> => {
    if (inFlight) {
      const draft = stashDeferrableDraft(intent);
      if (draft !== null) stashed.push({ draft, intent });
      return Promise.resolve();
    }
    return run(undefined, intent);
  };
}
