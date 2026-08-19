/**
 * One user action = one submission — without eating the NEXT user action.
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
 * boot/wake window for a sleeping sandbox. A blanket return held the gate for
 * that entire window and silently dropped every submission inside it, so the
 * second message a user typed right after the first NEVER reached the
 * busy→queue decision the composer owns. The queue existed precisely for that
 * message, and the latch stood in front of it.
 *
 * The two cases are distinguishable at the moment the re-entrant submit
 * arrives:
 *
 *  - **Double-fire** (the hazard the latch is for): the editor is already
 *    empty — dispatch cleared it synchronously. Dropped, as before.
 *  - **Distinct second message**: the user typed new text. Deferred — it
 *    re-runs once the in-flight dispatch settles. By then the session's
 *    optimistic busy status is set (synchronously, at send start), so the
 *    re-run routes into the message queue rather than double-sending.
 *
 * Repeated submissions while blocked collapse into ONE deferred re-run: the
 * re-run reads the live editor draft, which already contains everything the
 * user typed. A files-only second message (no text) inside the in-flight
 * window is indistinguishable from the hazard and stays dropped — that trade
 * is deliberate; the hazard's cost is a duplicate send on the wire.
 *
 * Framework-free on purpose so the deferral ordering is unit-testable with
 * real promises instead of source-text assertions.
 */
export function createSubmitLatch(
  dispatch: () => Promise<void>,
  /**
   * Whether the CURRENT draft carries typed text worth deferring for. Read at
   * re-entrant-submit time, so a cleared editor (double-fire) reads false and
   * a typed second message reads true.
   */
  hasDeferrableDraft: () => boolean,
): () => Promise<void> {
  let inFlight = false;
  let deferred = false;

  const submit = async (): Promise<void> => {
    if (inFlight) {
      if (hasDeferrableDraft()) deferred = true;
      return;
    }
    inFlight = true;
    try {
      await dispatch();
    } finally {
      // `finally`, so a throw from any dispatch path cannot wedge the composer
      // into permanently refusing to send. `dispatchSubmission` handles its own
      // send failure and restores the draft; this only releases the gate — and
      // runs the submission that arrived while it was closed.
      inFlight = false;
      if (deferred) {
        deferred = false;
        void submit();
      }
    }
  };

  return submit;
}
