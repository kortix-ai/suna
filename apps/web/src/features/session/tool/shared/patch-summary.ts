/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/patch-summary.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { patchVerb } from '@kortix/sdk';
export type { PatchOp, PatchVerb } from '@kortix/sdk';
