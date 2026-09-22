/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/file-verb.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { FILE_VERBS, filePhase, fileVerb } from '@kortix/sdk';
export type { FileAction, FilePhase, FileVerb } from '@kortix/sdk';
