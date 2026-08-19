/**
 * Turning the call record into the thing a reader actually looks at.
 *
 * `call-record.ts` answers "what is this row" — one entry per `voice_call_turns`
 * row, keyed by cursor, so a poll can merge pages without duplicating anything.
 * That mapping has to stay 1:1 for the merge to work, which is exactly why the
 * two things a READER needs cannot live there:
 *
 *  1. A hand-off is TWO rows. `askKortix` writes `ask_kortix: <request>` when it
 *     starts and `settleAsk` writes `ask_kortix_done: <outcome>` when it ends
 *     (apps/api channels/voice/ask-ledger.ts — they are the in-flight ledger,
 *     not decoration). Rendered as they are stored, one question shows up as two
 *     unrelated rows, the second one a bare word like "answered" with nothing
 *     saying what it answered. Here they are folded back into ONE row: the
 *     request, and how it turned out — or that it is still outstanding.
 *  2. A name on every single bubble is noise. Repeating "Kortix" six times down
 *     a run of six consecutive lines tells the reader nothing they did not
 *     already know from the last five.
 *
 * Folding needs the WHOLE record, not one page: an ask and its settle routinely
 * arrive on different polls (a hand-off takes seconds to minutes, the poll runs
 * every two). So this runs at render time over the merged record, and never on
 * an incoming page.
 *
 * Pure. No React, no dates-as-strings-in-the-UI, no formatting — the component
 * decides how a time is written, this decides what is shown at all.
 */
import type { CallRecordEntry } from './types';

/** `ASK_SPEAKER` / `ASK_SETTLED_SPEAKER` in apps/api's ask-ledger.ts, which is
 *  what ends up in `voice_call_turns.speaker` and therefore in `entry.name`. */
const ASK_TOOL = 'ask_kortix';
const ASK_SETTLED_TOOL = 'ask_kortix_done';

/**
 * How long a silence has to be before the same speaker is re-labelled.
 *
 * A run exists so consecutive lines are not stamped with the same name over and
 * over. But after a pause, "who was that again" is a real question — the reader
 * has looked away, or the call sat quiet while Kortix worked — and the label
 * stops being redundant. Two minutes is well past the gap between turns of a
 * conversation and well under the length of a lull.
 */
const RUN_GAP_MS = 120_000;

/** What `settleAsk` writes when it has no better word — see `foldAskSettlements`. */
const SETTLED_FALLBACK = 'done';

/**
 * One thing to render, in order.
 *
 * `entry.kind` still says what it is; these are the two facts that only exist
 * once the record is read as a whole rather than row by row.
 */
export interface FeedRow {
  /** React key. The cursor of the row this item is anchored to — for a folded
   *  hand-off that is the ASK's cursor, so the item keeps its position in the
   *  conversation rather than jumping to where it happened to finish. */
  key: number;
  entry: CallRecordEntry;
  /** Speech only: this line begins a run by someone new, so it carries the
   *  name. False on every continuation line. */
  showLabel: boolean;
  /** Tool only: opened and not yet closed — a hand-off Kortix is still working
   *  on. Distinct from `outcome === null`, which for any other tool just means
   *  the row never recorded one. */
  pending: boolean;
  /** Tool only: when the settle row landed, for a reader who wants to know how
   *  long it took. Null while pending, and for tools that settle inline. */
  settledAt: string | null;
}

/**
 * Folds each `ask_kortix_done` into the `ask_kortix` it closes.
 *
 * Pairing is positional — a settle closes the most recent still-open ask —
 * because that is precisely the invariant apps/api enforces: one hand-off at a
 * time, so there is never more than one open ask to choose between
 * (ask-ledger.ts's in-flight guard). Nothing is matched by content, and nothing
 * needs an id.
 *
 * A settle with no open ask is NOT dropped. It means the ask itself is missing
 * from what we hold — a stale in-flight row expiring, or a settle written twice
 * — and silently swallowing a real record row to keep the display tidy is the
 * failure mode this whole page exists to stop. It is shown on its own, named
 * for the tool it belongs to.
 */
export function foldAskSettlements(
  entries: readonly CallRecordEntry[],
): Array<{ entry: CallRecordEntry; pending: boolean; settledAt: string | null }> {
  const out: Array<{ entry: CallRecordEntry; pending: boolean; settledAt: string | null }> = [];
  let openAsk: number | null = null;

  for (const entry of entries) {
    if (entry.kind !== 'tool') {
      out.push({ entry, pending: false, settledAt: null });
      continue;
    }

    if (entry.name === ASK_TOOL) {
      out.push({ entry, pending: true, settledAt: null });
      openAsk = out.length - 1;
      continue;
    }

    if (entry.name === ASK_SETTLED_TOOL) {
      // The settle row's TEXT is the outcome — `interpretTool` already stripped
      // the `ask_kortix_done: ` prefix that made it parseable in the first place.
      const outcome = entry.text.trim() || SETTLED_FALLBACK;
      if (openAsk !== null) {
        const open = out[openAsk];
        if (open) {
          out[openAsk] = {
            entry: { ...open.entry, outcome },
            pending: false,
            settledAt: entry.at,
          };
          openAsk = null;
          continue;
        }
      }
      out.push({
        // Named for the hand-off it closes, not for the row that recorded it:
        // `ask_kortix_done` is an implementation detail of the ledger, and on
        // its own it would read as a second, different tool.
        entry: { ...entry, name: ASK_TOOL, text: '', outcome },
        pending: false,
        settledAt: entry.at,
      });
      continue;
    }

    out.push({ entry, pending: false, settledAt: null });
  }

  return out;
}

function startsNewRun(prev: CallRecordEntry | null, entry: CallRecordEntry): boolean {
  if (!prev) return true;
  if (prev.kind !== entry.kind || prev.name !== entry.name) return true;
  const gap = new Date(entry.at).getTime() - new Date(prev.at).getTime();
  // NaN (an unparseable stamp on either side) falls through to `true`: showing
  // one label too many is a smaller failure than dropping the only attribution
  // a line has.
  return !(gap < RUN_GAP_MS);
}

/**
 * Marks which speech lines carry a name.
 *
 * A TOOL ROW DOES NOT BREAK A RUN, deliberately. It is not someone else
 * speaking — nobody said it — and a hand-off in the middle of the voice
 * talking is the single most common thing on a call. Letting it re-label would
 * put the name back on almost every bubble, which is the noise this removes.
 */
export function markSpeakerRuns(
  rows: ReadonlyArray<{ entry: CallRecordEntry; pending: boolean; settledAt: string | null }>,
): FeedRow[] {
  let lastSpeech: CallRecordEntry | null = null;

  return rows.map((row) => {
    if (row.entry.kind === 'tool') {
      return { key: row.entry.cursor, ...row, showLabel: false };
    }
    const showLabel = startsNewRun(lastSpeech, row.entry);
    lastSpeech = row.entry;
    return { key: row.entry.cursor, ...row, showLabel };
  });
}

/** The record as the feed renders it: hand-offs folded, runs marked. */
export function buildFeed(entries: readonly CallRecordEntry[]): FeedRow[] {
  return markSpeakerRuns(foldAskSettlements(entries));
}

/**
 * How an outcome reads at a glance.
 *
 * The vocabulary is closed and comes from two places, both of which own their
 * words: `summarizeRunCommandOutcome` (apps/api channels/voice/mcp.ts) and
 * `WatchOutcome` (channels/voice/answer-watch.ts). Anything unrecognised is
 * NEUTRAL rather than an error — a new outcome word appearing in red would
 * report a failure that never happened.
 */
export type OutcomeTone = 'ok' | 'bad' | 'neutral';

const OK_OUTCOMES: ReadonlySet<string> = new Set(['ok', 'answered', 'exit 0']);
const BAD_OUTCOMES: ReadonlySet<string> = new Set([
  'failed',
  'timed out',
  'delivery failed',
  'not delivered',
  'session unreadable',
]);

/**
 * How long a hand-off took, from its ask row to its settle row — the one number
 * that says whether "answered" meant eight seconds or four minutes, which is
 * what a reader wondering why the call went quiet is actually asking.
 *
 * Null rather than "0s" for anything unreadable or backwards: two rows written
 * by different processes can carry stamps a hair out of order, and a negative
 * duration on screen is worse than no duration at all.
 */
export function elapsedLabel(fromIso: string, toIso: string): string | null {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

export function outcomeTone(outcome: string): OutcomeTone {
  const o = outcome.trim().toLowerCase();
  if (OK_OUTCOMES.has(o)) return 'ok';
  if (BAD_OUTCOMES.has(o)) return 'bad';
  // A non-zero exit is a failure whatever the number; `exit 0` is caught above.
  if (/^exit -?\d+$/.test(o)) return 'bad';
  return 'neutral';
}
