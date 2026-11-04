/**
 * The finish notices the API delivers as a prompt: a background sub-agent or a
 * workflow run this session started has ended, or several have. Pure logic
 * behind `components/session/turn/agent-notice.tsx`; port of apps/web
 * `session/turn/subagent-notice-row.tsx`, `notice-batch-group.tsx` and the
 * `isAgentNoticeTurn` / notice detection in `session/thread/transcript.tsx`.
 *
 * Strings are web's English locale (`multiAgent.notice`).
 */

import {
  extractSessionReport,
  noticeFirstLine,
  parseNoticeBatch,
  parseSubagentNotice,
  parseWorkflowResult,
  type NoticeBatchItem,
  type SubagentNotice,
} from '@kortix/sdk';
import type { SessionDisplayStatus } from '@/lib/session/session-list';

export type AgentNoticePrompt =
  | { kind: 'single'; notice: SubagentNotice }
  | { kind: 'batch'; items: NoticeBatchItem[] };

/**
 * The notice a prompt carries, or null for a prompt a person typed. A batch is
 * two or more coalesced notices; a single one is a sub-agent notice that also
 * carries its session report (web reads it only then).
 */
export function agentNoticeOf(text: string): AgentNoticePrompt | null {
  const batch = parseNoticeBatch(text);
  if (batch && batch.length > 1) return { kind: 'batch', items: batch };
  if (!extractSessionReport(text)) return null;
  const notice = parseSubagentNotice(text);
  return notice ? { kind: 'single', notice } : null;
}

/** A workflow's report arrives wrapped in `<workflow_result>`: the person reads what is inside. */
const RESULT_TAG = /<\/?workflow_?result>/gi;
/** A run's own name carries " (workflow)"; the line names the run. */
const WORKFLOW_SUFFIX = /\s*\(workflow\)\s*$/i;
/** A first line that only says it is done repeats "finished". */
const FILLER = /^(done|finished|completed?|all done|ok(ay)?)[.!]*$/i;

export function noticeReport(text: string): string {
  // A JSON result reads as its document (web `workflowResultMarkdown`), never as the JSON source;
  // a finish notice carries the body without the tag.
  const parsed = parseWorkflowResult(text.includes('<workflow_result>') ? text : `<workflow_result>${text}</workflow_result>`);
  const readable = !parsed ? text : parsed.kind === 'json' ? `\`\`\`json\n${parsed.text}\n\`\`\`` : parsed.text;
  return readable.replace(RESULT_TAG, '').trim();
}

export function noticeName(notice: SubagentNotice): string {
  return (notice.handle || notice.title || notice.agent || 'Your agent').replace(WORKFLOW_SUFFIX, '');
}

export const NOTICE_GLYPH: Record<SubagentNotice['status'], SessionDisplayStatus> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

export function noticeHeadline(notice: SubagentNotice): string {
  const name = noticeName(notice);
  if (notice.status === 'failed') return `${name} didn’t finish`;
  if (notice.status === 'stopped') return `${name} was stopped`;
  return `${name} finished`;
}

/** The report's first line with words, unless it only says it is done. */
export function noticeExcerpt(report: string): string | null {
  const first = noticeFirstLine(report);
  return first && !FILLER.test(first) ? first : null;
}

export function batchTitle(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'} finished`;
}
