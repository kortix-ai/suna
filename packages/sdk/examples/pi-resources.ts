import {
  definePiAgent,
  type PiAgentContext,
  type PiAgentResource,
  type PiAgentResources,
} from '@kortix/sdk/pi';

const legacyContext: PiAgentContext = {} as Omit<PiAgentContext, 'resources'>;
void legacyContext;

export default definePiAgent(async ({ resources }) => {
  if (!resources) throw new Error('This agent requires a worker with bundled resources');
  const files: readonly PiAgentResource[] = resources.list();
  const reader: PiAgentResources = resources;
  const rules = await reader.readJson('rules');
  return {
    initialize: async () => {
      if (!files.length || !rules) throw new Error('Missing agent rules');
    },
  };
});
