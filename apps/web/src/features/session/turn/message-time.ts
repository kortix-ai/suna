/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/message-time.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { formatMessageDay, formatMessageExact, messageCreatedAt, messageTime } from '@kortix/sdk';
export type { MessageTimeOptions } from '@kortix/sdk';
