/**
 * Turning `voice_call_turns` rows into something a person can read — and
 * keeping the live LiveKit tail from repeating what the record already holds.
 *
 * Pure, no React, no network: the rules here are the whole reason the call
 * page was wrong before, so they are the part that has to be testable on its
 * own (call-record.test.ts).
 *
 * THE ROLE/SPEAKER RULES, in one place. A row's `role` alone does not say who
 * said it, because `agent` covers two different actors:
 *
 *   role=user                    → a human in the room.
 *   role=agent, speaker=kortix   → the KORTIX agent putting words into the call
 *                                  (apps/api channels/voice/utterance.ts's
 *                                  KORTIX_SPEAKER).
 *   role=agent, speaker=<other>  → the voice itself, labelled with the bot's
 *                                  display name by the worker
 *                                  (apps/voice-agent/src/transcripts.ts).
 *   role=tool                    → an MCP call the voice made; `speaker` is the
 *                                  tool name and nobody spoke.
 *
 * Reading `role` without `speaker` is exactly how the dosco agent's own lines
 * end up indistinguishable from the voice's — do not collapse these.
 */
import type { CallEntryKind, CallRecordEntry, LiveUtterance } from './types';

/** Matches `KORTIX_SPEAKER` in apps/api/src/channels/voice/utterance.ts. */
const KORTIX_SPEAKER = 'kortix';

/** A row as the public transcript endpoint returns it. Structurally the SDK's
 *  `PublicVoiceTranscriptTurn`; restated so this module stays importable from
 *  a test without dragging the SDK in. */
export interface RawCallTurn {
  cursor: number;
  role: string;
  speaker: string | null;
  text: string;
  at: string;
}

/**
 * The outcomes `run_command` appends to its transcript line (apps/api
 * channels/voice/mcp.ts's `summarizeRunCommandOutcome`, plus the `failed` its
 * catch branch writes).
 *
 * The split is anchored to this exact vocabulary rather than "text after the
 * last arrow" because `ask_kortix` writes NO outcome, and a request that
 * happens to contain an arrow would otherwise have its last few words torn off
 * and relabelled as a result.
 */
function parseOutcome(tail: string): string | null {
  const t = tail.trim();
  if (t === 'ok' || t === 'failed' || t === 'timed out') return t;
  if (/^exit -?\d+$/.test(t)) return t;
  return null;
}

const ARROW = ' → ';

function interpretTool(
  speaker: string | null,
  text: string,
): { name: string; text: string; outcome: string | null } {
  const name = speaker?.trim() || 'tool';

  let body = text;
  let outcome: string | null = null;
  const arrowAt = body.lastIndexOf(ARROW);
  if (arrowAt !== -1) {
    const parsed = parseOutcome(body.slice(arrowAt + ARROW.length));
    if (parsed) {
      outcome = parsed;
      body = body.slice(0, arrowAt);
    }
  }

  // The row's text repeats the tool name as a prefix (`run_command: ls`)
  // because the agent reading its own transcript gets no `speaker` column to
  // look at. Here the name is already its own badge, so showing it twice is
  // just noise.
  const prefix = `${name}:`;
  if (body.toLowerCase().startsWith(prefix.toLowerCase())) {
    body = body.slice(prefix.length);
  }

  return { name, text: body.trim(), outcome };
}

/** Applies the role/speaker rules above. Rows with no text are dropped — an
 *  empty bubble tells a reader nothing and `appendTurn` should not have
 *  written one. */
export function toCallRecordEntries(turns: readonly RawCallTurn[]): CallRecordEntry[] {
  const entries: CallRecordEntry[] = [];

  for (const turn of turns) {
    const speaker = turn.speaker?.trim() || null;
    const text = turn.text?.trim() ?? '';
    if (!text) continue;

    let kind: CallEntryKind;
    let name: string;
    let body = text;
    let outcome: string | null = null;

    if (turn.role === 'tool') {
      kind = 'tool';
      const parsed = interpretTool(speaker, text);
      name = parsed.name;
      body = parsed.text;
      outcome = parsed.outcome;
    } else if (turn.role === 'agent') {
      if (speaker === KORTIX_SPEAKER) {
        kind = 'kortix';
        name = 'dosco agent';
      } else {
        kind = 'voice';
        name = speaker || 'dosco';
      }
    } else {
      kind = 'human';
      // The worker posts the user side without a speaker (it has no name for
      // whoever is in the room), so this is the common case, not a fallback.
      name = speaker || 'Guest';
    }

    entries.push({ cursor: turn.cursor, kind, name, text: body, outcome, at: turn.at });
  }

  return entries;
}

/** Merges a fresh page onto what's already displayed. The cursor is monotonic
 *  per call, so a re-delivered row replaces rather than duplicates — a retried
 *  poll must never double the transcript. */
export function mergeCallRecord(
  existing: readonly CallRecordEntry[],
  incoming: readonly CallRecordEntry[],
): CallRecordEntry[] {
  if (incoming.length === 0) return existing as CallRecordEntry[];
  const byCursor = new Map<number, CallRecordEntry>();
  for (const e of existing) byCursor.set(e.cursor, e);
  for (const e of incoming) byCursor.set(e.cursor, e);
  return Array.from(byCursor.values()).sort((a, b) => a.cursor - b.cursor);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Which live LiveKit utterances the durable record does NOT yet account for.
 *
 * The record is the transcript; LiveKit's client stream is only how the page
 * shows a sentence before the server has finished writing it down. So an
 * utterance is dropped from the tail the moment a durable line says the same
 * words — matched by text, greedily and one-for-one, so someone saying "yes"
 * twice retires two live lines and not one.
 *
 * An utterance still being revised (`final === false`) is never retired: it is
 * not the finished sentence, so matching it against a recorded one would be a
 * coincidence.
 *
 * Deliberately keeps an unmatched final utterance instead of expiring it. If
 * the server never records the line, showing it anyway is the failure mode
 * that loses nothing; hiding it is the one that reproduces the bug this whole
 * change exists to fix.
 */
export function unrecordedLive(
  live: readonly LiveUtterance[],
  entries: readonly CallRecordEntry[],
): LiveUtterance[] {
  const spokenCounts = new Map<string, number>();
  for (const e of entries) {
    // A tool line was never spoken, so it can never be the record of something
    // heard on the call.
    if (e.kind === 'tool') continue;
    const key = normalize(e.text);
    spokenCounts.set(key, (spokenCounts.get(key) ?? 0) + 1);
  }

  const out: LiveUtterance[] = [];
  for (const utterance of live) {
    if (!utterance.final) {
      out.push(utterance);
      continue;
    }
    const key = normalize(utterance.text);
    const remaining = spokenCounts.get(key) ?? 0;
    if (remaining > 0) {
      spokenCounts.set(key, remaining - 1);
      continue;
    }
    out.push(utterance);
  }
  return out;
}
