import { definePiAgent } from '../src/core/pi/agent';

// In a project agent module: import { definePiAgent } from '@kortix/sdk/pi';
export default definePiAgent(({ state }) => ({
  tools: [
    {
      name: 'increment_counter',
      label: 'Increment counter',
      description: 'Increment a session counter that survives worker replacement.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const counter = await state.open('counter', {
          schemaVersion: 1,
          initialValue: { count: 0 },
        });
        const saved = await counter.update((value) => ({ count: value.count + 1 }));
        return {
          content: [{ type: 'text', text: `Counter: ${saved.value.count}` }],
          details: { revision: saved.revision },
        };
      },
    },
  ],
}));
