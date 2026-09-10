import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { QuestionCheckpoint } from './question-checkpoint.ts';
import { planToolReplay } from './tool-replay.ts';
export { installToolReplay as installQuestionReplay } from './tool-replay.ts';
export type { ToolReplayPlan as QuestionReplayPlan } from './tool-replay.ts';

export function planQuestionReplay(
  messages: readonly AgentMessage[],
  checkpoint: QuestionCheckpoint,
) {
  return planToolReplay(
    messages,
    checkpoint,
    (tool) =>
      tool.name === 'question' &&
      isDeepStrictEqual(tool.arguments.questions, checkpoint.request.questions),
    'question',
  );
}
