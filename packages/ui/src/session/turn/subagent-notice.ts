import { parsePeerMessagePrompt, tagBlocks, type PeerMessagePromptInfo } from '@kortix/shared';
import { extractSessionReport } from '../../internal/lib/utils/kortix-system-tags';

/**
 * The notices the API delivers into a session as a prompt, written by
 * `subagentNoticeText` in `apps/api/src/projects/subagent-notice.ts`:
 *
 *   A background subagent you started has finished. This message is from the platform, not from the user.
 *   (or) Your teammate <handle> finished its turn and is idle. This message is from the platform, not from the user.
 *   task_id: <child session id>
 *   status: completed | error | failed | stopped
 *
 *   <kortix_system type="session-report" source="subagent"><session-report>…</session-report></kortix_system>
 *
 *   Tasks <handle> still owns: #3 subject (in progress); … .   (a teammate only)
 *   …
 *
 * `apps/api/src/projects/session-notice-batch.ts` coalesces the notices that
 * arrive together into one prompt, joined by a blank line (at most 20): these,
 * and the idle notice a `send_message({ notify_when_idle })` asked for
 * (`peerMessagePromptText` kind `idle_notice`).
 */
export interface SubagentNotice {
  /** `teammate`: a teammate of an agent team went idle; `subagent`: a background subagent ended. */
  kind: 'subagent' | 'teammate';
  sessionId: string;
  status: 'completed' | 'failed' | 'stopped';
  /** A teammate's handle, from its lead line; null for a subagent. */
  handle: string | null;
  /** The project agent the child ran as, or null. */
  agent: string | null;
  /** The child's title, without the "(@agent subagent)" suffix, or null. */
  title: string | null;
  /** The child's final report (Markdown), or its error. */
  result: string;
  /** The first line of `result` that holds words. */
  excerpt: string;
  /** A teammate's unfinished tasks ("#3 Write the fix (in progress); #4 …"), or null when it owns none. */
  ownedTasks: string | null;
}

/** One notice of a delivered notice prompt. */
export type NoticeBatchItem =
  | { kind: 'subagent' | 'teammate'; notice: SubagentNotice }
  | { kind: 'peer_idle'; info: PeerMessagePromptInfo };

const SUBAGENT_LEAD = 'A background subagent you started has finished.';
const TEAMMATE_LEAD = /^Your teammate (\S+) finished its turn and is idle\./;
const PEER_IDLE_HEAD = '[idle notice from ';
const STATUSES = new Set(['completed', 'failed', 'stopped']);
/** `session-notice-batch.ts` `NOTICE_BATCH_MAX`; a longer prompt is not a batch it wrote. */
const MAX_NOTICES = 20;

function block(text: string, tag: string): string | null {
  const found = tagBlocks(text, tag, { limit: 1 })[0];
  return found ? found.body.trim() : null;
}

/** The first line with words, without Markdown heading, list and emphasis marks. */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '')
      .replace(/[*_`]+/g, '')
      .trim();
    if (line) return line;
  }
  return '';
}

/** The background subagent or teammate notice a text carries (one notice, not a batch), or null. */
export function parseSubagentNotice(text: string | null | undefined): SubagentNotice | null {
  if (!text) return null;
  const body = text.trimStart();
  const teammate = TEAMMATE_LEAD.exec(body);
  if (!teammate && !body.startsWith(SUBAGENT_LEAD)) return null;
  const report = extractSessionReport(body);
  const head = body.slice(0, 600);
  const sessionId = /^task_id:\s*(\S+)/m.exec(head)?.[1] ?? report?.sessionId ?? '';
  if (!sessionId) return null;
  const stated = /^status:\s*(\w+)/m.exec(head)?.[1];
  // The API writes `error` for a turn that ended on an error; it reads as a failure.
  const normalized = stated === 'error' ? 'failed' : stated;
  const status: SubagentNotice['status'] =
    normalized && STATUSES.has(normalized)
      ? (normalized as SubagentNotice['status'])
      : report?.status === 'FAILED'
        ? 'failed'
        : 'completed';
  const resultXml = report?.result ?? '';
  const answer = block(resultXml, 'task_result');
  const error = block(resultXml, 'task_error');
  const result = (status === 'completed' ? answer : (error ?? answer)) ?? resultXml;
  const title = report?.prompt?.replace(/\s*\(@[^)]*\bsubagent\)\s*$/i, '').trim() || null;
  const handle = teammate?.[1] ?? null;
  const owned = handle ? /^Tasks \S+ still owns: (.+?)\.?$/m.exec(body)?.[1]?.trim() : undefined;
  return {
    kind: teammate ? 'teammate' : 'subagent',
    sessionId,
    status,
    handle,
    agent: report?.project?.trim() || null,
    title,
    result,
    excerpt: firstLine(result),
    ownedTasks: owned || null,
  };
}

/** True when a notice of any kind starts at `index` of `text`. */
function startsNotice(text: string, index: number): boolean {
  return (
    text.startsWith(SUBAGENT_LEAD, index) ||
    text.startsWith(PEER_IDLE_HEAD, index) ||
    (text.startsWith('Your teammate ', index) && TEAMMATE_LEAD.test(text.slice(index, index + 300)))
  );
}

/**
 * The notices a delivered prompt carries, in order, or null when the prompt is
 * anything else. A notice starts at the start of the prompt or right after the
 * blank line that joins two notices, so a notice line quoted inside a report
 * never splits one. Every piece must parse: one that does not makes the whole
 * prompt "not a batch", and it renders as the turn it is.
 */
export function parseNoticeBatch(text: string | null | undefined): NoticeBatchItem[] | null {
  if (!text) return null;
  const body = text.trim();
  if (!startsNotice(body, 0)) return null;
  const starts = [0];
  for (let at = body.indexOf('\n\n'); at !== -1; at = body.indexOf('\n\n', at + 2)) {
    // Several blank lines in a row: the notice starts at the first non-newline.
    let index = at + 2;
    while (body[index] === '\n') index += 1;
    if (index > starts[starts.length - 1]! && startsNotice(body, index)) starts.push(index);
    if (starts.length > MAX_NOTICES) return null;
  }
  const items: NoticeBatchItem[] = [];
  for (const [i, start] of starts.entries()) {
    const piece = body.slice(start, starts[i + 1] ?? body.length).trim();
    if (piece.startsWith(PEER_IDLE_HEAD)) {
      const info = parsePeerMessagePrompt(piece);
      if (!info || info.kind !== 'idle_notice') return null;
      items.push({ kind: 'peer_idle', info });
      continue;
    }
    const notice = parseSubagentNotice(piece);
    if (!notice) return null;
    items.push({ kind: notice.kind, notice });
  }
  return items;
}
