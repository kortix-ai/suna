/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/skill-helpers.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  extractSkillBaseDir,
  extractSkillContent,
  extractSkillFiles,
  skillDocumentPath,
  skillInputDir,
} from '@kortix/sdk';
