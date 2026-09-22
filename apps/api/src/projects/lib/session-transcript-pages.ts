import {
  mirrorRowsFromOpencodePayload,
  type MirrorMessage,
} from "./session-transcript-mirror";

/** The result of walking transcript pages. */
export interface TranscriptPageWalk {
  rows: MirrorMessage[];
  /** The walk reached the session's FIRST message — the box answered a page
   *  with no cursor behind it. Only a walk that got there may be treated as
   *  the complete truth about which messages exist. */
  headComplete: boolean;
  /**
   * Every page this walk meant to read was read.
   *
   * False for a bounded tail read (it never tried), and false when the walk
   * stopped early — a page that failed, a daemon that repeated a cursor, or a
   * walk that caught up with already-captured history. The writer keys its
   * DELETE on this: only a complete walk can tell "this message is gone
   * upstream" apart from "I did not read that far".
   */
  complete: boolean;
  /**
   * The walk stopped because it reached a page it already holds, unchanged.
   *
   * Everything older is therefore already captured too, so this is a
   * SUCCESSFUL stop — unlike a failed page. The writer may still delete inside
   * the range the walk covered (a rewind removes the newest messages, which is
   * exactly what an incremental read sees) but never below it.
   */
  caughtUp: boolean;
}

/**
 * Walk the runtime's message pages, newest first.
 *
 * WHAT WAS READ IS KEPT. A page failing partway used to reject the whole walk,
 * so one 503 on page 7 of 9 threw away six good pages AND the newest turn —
 * which stayed unmirrored until some later capture happened to succeed. That
 * made sense while the writer deleted the session's whole history before
 * re-inserting it, where a fragment would have REPLACED good stored rows. The
 * writer now merges, and deletes only what a COMPLETE walk proves is gone, so
 * a partial walk cannot destroy anything.
 *
 * A first page that fails still throws: nothing was read, so there is nothing
 * to keep, and "the box is unreachable" is exactly what the capture retries.
 */
export async function readTranscriptPages(
  readPage: (cursor?: string) => Promise<Response>,
  fullHistory: boolean,
  prepareMessages?: (messages: unknown[]) => Promise<unknown[]>,
  /**
   * "Is this whole page already captured, unchanged?" Answering true stops the
   * walk: pages run newest-first, so a page we already hold means everything
   * below it is held too. Omitted, the walk always runs to the head.
   *
   * The CALLER owns the gate on whether stopping is sound at all — it is only
   * sound when a previous capture proved it reached the session's first
   * message. See `session-transcript-capture.ts`.
   */
  isAlreadyCaptured?: (rows: MirrorMessage[]) => boolean,
): Promise<TranscriptPageWalk> {
  const messages = new Map<string, MirrorMessage>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let headComplete = false;
  let complete = false;
  let caughtUp = false;
  let pagesRead = 0;

  const finish = (): TranscriptPageWalk => {
    const rows = [...messages.values()].sort((a, b) => {
      const created = (row: MirrorMessage) =>
        Number((row.info.time as { created?: number })?.created ?? 0);
      return (
        created(a) - created(b) ||
        String(a.info.id).localeCompare(String(b.info.id))
      );
    });
    return { rows, headComplete, complete, caughtUp };
  };

  do {
    let response: Response;
    try {
      response = await readPage(cursor);
    } catch (error) {
      if (pagesRead === 0) throw error;
      return finish();
    }
    if (!response.ok) {
      if (pagesRead === 0)
        throw new Error(`Transcript read failed: HTTP ${response.status}`);
      return finish();
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      if (pagesRead === 0) throw new Error("Invalid transcript page");
      return finish();
    }
    const pageRows = mirrorRowsFromOpencodePayload(
      prepareMessages ? await prepareMessages(payload) : payload,
    );
    for (const row of pageRows) {
      const id = String(row.info.id);
      if (!messages.has(id)) messages.set(id, row);
    }
    pagesRead += 1;
    // `pageRows.length > 0` guards the vacuous truth: `every` over nothing is
    // true, and an empty page says the walk ran past the end, never that the
    // rows below it are already stored.
    if (fullHistory && pageRows.length > 0 && isAlreadyCaptured?.(pageRows)) {
      caughtUp = true;
      return finish();
    }
    cursor = response.headers.get("x-next-cursor") || undefined;
    headComplete = !cursor;
    // A cursor the walk has already followed means the daemon is not
    // advancing. Stop and keep what landed. This used to throw; a repeat can
    // only ever be SEEN with at least one page already in hand (the set is
    // empty on the first page), so throwing here could only ever discard good
    // pages to punish the daemon for a defect they do not share.
    if (cursor && cursors.has(cursor)) {
      headComplete = false;
      return finish();
    }
    if (cursor) cursors.add(cursor);
  } while (fullHistory && cursor);

  // Only a full walk that ran out of cursors read everything it meant to.
  complete = fullHistory && headComplete;
  return finish();
}

export async function retryTranscriptCapture<T>(
  capture: () => Promise<T | null>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await capture();
      if (result !== null) return result;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    if (attempt < 2) await wait(250 * 2 ** attempt);
  }
  return null;
}
