export function buildRuntimeSessionCreateInput(input: {
  title?: string;
  initialPrompt?: string;
}): { name?: string; initial_prompt?: string } {
  return {
    ...(input.title ? { name: input.title } : {}),
    ...(input.initialPrompt?.trim() ? { initial_prompt: input.initialPrompt.trim() } : {}),
  };
}
