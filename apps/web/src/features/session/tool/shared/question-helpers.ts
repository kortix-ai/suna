/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/question-helpers.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export { parseQuestionAnswersFromOutput } from '@kortix/sdk';
export type { ParsedQuestion } from '@kortix/sdk';
