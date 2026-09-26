/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/segment-turn.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { segmentTurn } from '@kortix/sdk';
export type { Segment, SegmentTurnOptions } from '@kortix/sdk';
