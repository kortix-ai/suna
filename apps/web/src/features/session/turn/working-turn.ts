/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/working-turn.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { freshSendHint, resolveWorkingTurn } from '@kortix/sdk';
export type { WorkingTurnResolution } from '@kortix/sdk';
