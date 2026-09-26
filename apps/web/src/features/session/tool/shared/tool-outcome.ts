/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/tool-outcome.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  cleanErrorMessage,
  formatJsonFailureOutput,
  isErrorOutput,
  looksLikeError,
  parseJsonFailure,
  partOutcome,
} from '@kortix/sdk';
export type { ToolOutcome } from '@kortix/sdk';
