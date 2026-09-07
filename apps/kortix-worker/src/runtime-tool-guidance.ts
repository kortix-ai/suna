export function appendRuntimeToolGuidance(
  prompt: string,
  tools: readonly { name: string }[],
): string {
  const names = new Set(tools.map((tool) => tool.name));
  const lines = [
    '## Current runtime capabilities',
    `Registered tools: ${[...names].join(', ')}.`,
    'This tool registry describes current availability, including capabilities added after the agent prompt was written.',
    'Keep the agent-specific restrictions on tool use.',
    'Call tools normally; the runtime requests permission when the configured policy requires it.',
    'Do not invent a separate permission tool or replace a permission request with a text question.',
  ];
  if (names.has('question')) {
    lines.push('Use question to collect answers through the interactive question UI.');
  }
  if (names.has('todowrite') && names.has('todoread')) {
    lines.push('Use todowrite and todoread to maintain the visible session plan.');
  }
  if (names.has('skill')) {
    lines.push('Use skill to load an available compiled skill. Read and execute its support files in the environment with the workspace tools.');
  }
  return `${prompt}\n\n${lines.join('\n')}`;
}
