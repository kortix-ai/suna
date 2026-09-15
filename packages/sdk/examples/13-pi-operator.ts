import { definePiAgent } from '../src/core/pi/agent';

export default definePiAgent(({ env, sessionId }) => ({
  tools: [
    {
      name: 'write_note',
      label: 'Write note',
      description: 'Write a session note in the execution environment, then read it back.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { text } = params as { text: string };
        const path = `/workspace/note-${sessionId}.txt`;
        const write = await env.writeFile(path, text);
        if (!write.ok) throw write.error;
        const read = await env.readTextFile(path);
        if (!read.ok) throw read.error;
        return { content: [{ type: 'text', text: read.value }], details: { path } };
      },
    },
  ],
}));
