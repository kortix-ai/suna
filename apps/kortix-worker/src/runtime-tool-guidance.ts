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
  if (names.has('websearch')) {
    lines.push('Use websearch for current information and cite the returned source URLs.');
  }
  if (names.has('webfetch')) {
    lines.push('Use webfetch to open public source URLs. Use environment tools for private workspace services and downloads.');
  }
  if (names.has('skill')) {
    lines.push('Use skill to load an available compiled skill. Read and execute its support files in the environment with the workspace tools.');
  }
  if (names.has('connector_search') && names.has('connector_describe') && names.has('connector_call')) {
    lines.push('Use connector_search to find authorized project tools, including remote MCP tools. Inspect the input schema with connector_describe, then use connector_call. These tools run through the connector gateway and leave the environment off.');
    lines.push('A pending connector approval includes an approval link. Show that link and wait for the user; do not repeat the action or poll for approval. Stop cancels the worker request but cannot undo an action already accepted by the remote service.');
  }
  return `${prompt}\n\n${lines.join('\n')}`;
}
