import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { QuestionRequest } from '@opencode-ai/sdk/v2';
import { Type } from 'typebox';

import type { QuestionBroker } from './question-broker.ts';

const questionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: 'Short display text for this choice' }),
  description: Type.String({ minLength: 1, description: 'One sentence that explains this choice' }),
});

const questionSchema = Type.Object({
  question: Type.String({ minLength: 1, description: 'The complete question for the user' }),
  header: Type.String({
    minLength: 1,
    maxLength: 30,
    description: 'A short label for the question',
  }),
  options: Type.Array(questionOptionSchema, {
    minItems: 1,
    description: 'The choices the user can select',
  }),
  multiple: Type.Optional(Type.Boolean({ description: 'Allow more than one selection' })),
  custom: Type.Optional(Type.Boolean({ description: 'Allow a free-form answer' })),
});

const questionToolSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    minItems: 1,
    description: 'Questions to show together in one user interaction',
  }),
});

function formatAnswers(questions: Array<{ header: string }>, answers: string[][]): string {
  return answers
    .map(
      (answer, index) =>
        `${questions[index]?.header ?? `Question ${index + 1}`}: ${answer.join(', ')}`,
    )
    .join('\n');
}

/** Pi tool that uses the same pending-question protocol as OpenCode. */
export function createQuestionTool(
  broker: QuestionBroker,
  toolContext?: (toolCallId: string) => QuestionRequest['tool'],
): AgentTool<typeof questionToolSchema> {
  return {
    name: 'question',
    label: 'question',
    description:
      'Ask the user one or more questions when their choice is required. The call waits for the user to answer or reject it.',
    parameters: questionToolSchema,
    executionMode: 'sequential',
    async execute(toolCallId, { questions }, signal) {
      const answers = await broker.ask(questions, { signal, tool: toolContext?.(toolCallId) });
      return {
        content: [{ type: 'text', text: formatAnswers(questions, answers) }],
        details: { answers },
      };
    },
  };
}
