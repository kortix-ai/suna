import { beforeEach, describe, expect, test } from 'bun:test';
import { useLocalConfigStore } from './use-local-config';

const gpt = { providerID: 'kortix', modelID: 'gpt-astra' };

describe('setModelForAgent — the per-agent pick home and the thread share', () => {
  beforeEach(() => useLocalConfigStore.setState({ agentModels: {} }));

  test('a pick persists for its agent', () => {
    useLocalConfigStore.getState().setModelForAgent('kortix', gpt);
    expect(useLocalConfigStore.getState().agentModels.kortix).toEqual(gpt);
  });

  test('null clears the pick, so the agent follows the default again', () => {
    useLocalConfigStore.getState().setModelForAgent('kortix', gpt);
    useLocalConfigStore.getState().setModelForAgent('kortix', null);
    expect('kortix' in useLocalConfigStore.getState().agentModels).toBe(false);
  });
});
