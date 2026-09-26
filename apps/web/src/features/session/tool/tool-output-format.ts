/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/tool-output-format.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  cleanResultSnippet,
  formatRawOutput,
  looksLikeJsonPayload,
  parseEmbeddedFailure,
  recoverLinkResults,
} from '@kortix/sdk';
export type { EmbeddedFailure, RecoveredResult } from '@kortix/sdk';
