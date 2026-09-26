/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/show-availability.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { isShowContentUnavailable, isShowPayloadEmpty } from '@kortix/sdk';
export type { ShowAvailabilityInput, ShowLoadStatus } from '@kortix/sdk';
