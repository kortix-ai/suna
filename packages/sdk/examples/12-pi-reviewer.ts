import { definePiAgent } from '../src/core/pi/agent';

export default definePiAgent(() => {
  let turns = 0;
  return {
    thinkingLevel: 'low',
    onEvent(event) {
      if (event.type === 'turn_start') turns++;
    },
    tools: [
      {
        name: 'review_text',
        label: 'Review text',
        description: 'Count words in supplied text without starting the execution environment.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const { text } = params as { text: string };
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          return {
            content: [{ type: 'text', text: JSON.stringify({ words, turns }) }],
            details: { words, turns },
          };
        },
      },
    ],
  };
});
