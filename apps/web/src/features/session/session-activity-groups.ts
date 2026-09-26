/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/session-activity-groups.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  NO_GROUP_ACTIVITY_TOOLS,
  STANDALONE_TOOLS,
  isEmptyShowPart,
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isQuestionTool,
  isShellActivityTool,
  isStandaloneActivityTool,
  normalizeActivityToolName,
  shellActivityGroupLabel,
  writeActivityGroupLabel,
} from '@kortix/sdk';
export type { ActivityPartLike } from '@kortix/sdk';
