/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/merge-steps.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { flattenThought, mergeBurstSteps, reasoningIsRunning } from '@kortix/sdk';
export type { BurstStep } from '@kortix/sdk';
