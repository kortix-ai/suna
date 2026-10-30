import { tagBlocks } from '@kortix/shared';
import { extractSessionReport } from '../../internal/lib/utils/kortix-system-tags';

/**
 * The notice the API delivers into a parent session when a background subagent
 * (or a background workflow runner) it started ends (`subagentNoticeText` in
 * `apps/api/src/projects/subagent-notice.ts`):
 *
 *   A background subagent you started has finished. This message is from the platform, not from the user.
 *   task_id: <child session id>
 *   status: completed | failed | stopped
 *
 *   <kortix_system type="session-report" source="subagent"><session-report>…</session-report></kortix_system>
 *   …
 */
export interface SubagentNotice {
  sessionId: string;
  status: 'completed' | 'failed' | 'stopped';
  /** The project agent the child ran as, or null. */
  agent: string | null;
  /** The child's title, without the "(@agent subagent)" suffix, or null. */
  title: string | null;
  /** The child's final report (Markdown), or its error. */
  result: string;
  /** The first line of `result` that holds words. */
  excerpt: string;
}

const LEAD = 'A background subagent you started has finished.';
const STATUSES = new Set<SubagentNotice['status']>(['completed', 'failed', 'stopped']);

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

/** The background subagent notice a prompt carries, or null for any other text. */
export function parseSubagentNotice(text: string | null | undefined): SubagentNotice | null {
  if (!text || !text.trimStart().startsWith(LEAD)) return null;
  const report = extractSessionReport(text);
  const head = text.slice(0, 600);
  const sessionId = /^task_id:\s*(\S+)/m.exec(head)?.[1] ?? report?.sessionId ?? '';
  if (!sessionId) return null;
  const stated = /^status:\s*(\w+)/m.exec(head)?.[1] as SubagentNotice['status'] | undefined;
  const status = stated && STATUSES.has(stated) ? stated : report?.status === 'FAILED' ? 'failed' : 'completed';
  const resultXml = report?.result ?? '';
  const answer = block(resultXml, 'task_result');
  const error = block(resultXml, 'task_error');
  const result = (status === 'completed' ? answer : (error ?? answer)) ?? resultXml;
  const title = report?.prompt?.replace(/\s*\(@[^)]*\bsubagent\)\s*$/i, '').trim() || null;
  return {
    sessionId,
    status,
    agent: report?.project?.trim() || null,
    title,
    result,
    excerpt: firstLine(result),
  };
}
