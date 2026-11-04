/**
 * The background subagent, teammate and peer idle notices the API delivers
 * into a session as a prompt. The parsers live in `@kortix/sdk`
 * (`core/turns/subagent-notice.ts`); this file keeps the old import path.
 */
export {
  noticeFirstLine as firstLine,
  parseNoticeBatch,
  parseSubagentNotice,
  type NoticeBatchItem,
  type SubagentNotice,
} from '@kortix/sdk';
