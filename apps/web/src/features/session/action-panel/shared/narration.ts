/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/narration.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  contextLabelForTool,
  createArtifactKind,
  familyForTool,
  narrationToolName as humanizeToolName,
  narrateFailedStep,
  narrateStep,
} from '@kortix/sdk';
export type { CreateArtifactKind, StepFamily } from '@kortix/sdk';
