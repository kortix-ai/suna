import type { Agent } from '@earendil-works/pi-agent-core';

const stepLimitMessage =
  'The agent step limit has been reached. Tools are unavailable until the next user prompt. ' +
  'Respond with text that explains the limit, summarizes completed work, lists unfinished tasks, ' +
  'and recommends the next action. Do not request another tool.';

export function applyAgentSteps(agent: Agent, steps: number | undefined): void {
  if (steps === undefined) return;
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new Error('compiled agent steps must be a positive safe integer');
  }

  let currentStep = 0;
  agent.subscribe((event) => {
    if (event.type === 'agent_start') currentStep = 0;
  });
  const stream = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    currentStep++;
    return stream(
      model,
      currentStep >= steps
        ? {
            ...context,
            tools: [],
            systemPrompt: `${context.systemPrompt ?? ''}\n\n${stepLimitMessage}`,
          }
        : context,
      options,
    );
  };

  const beforeToolCall = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    if (currentStep >= steps) {
      return { block: true, terminate: true, reason: stepLimitMessage };
    }
    return beforeToolCall?.(context, signal);
  };
  const shouldStopAfterTurn = agent.shouldStopAfterTurn;
  agent.shouldStopAfterTurn = (context, signal) =>
    currentStep >= steps || (shouldStopAfterTurn?.(context, signal) ?? false);
}
