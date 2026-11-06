import { beforeEach, describe, expect, test } from 'bun:test';
import { storage } from '@/stores/in-memory-async-storage';
import { LEGACY_LOCAL_CONFIG_KEY, LOCAL_CONFIG_KEY, useLocalConfigStore } from './local-config';

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

describe('persisted picks under the legacy key', () => {
  beforeEach(() => storage.clear());

  test('a pick saved under the legacy key is read, and the next write uses the new key', async () => {
    storage.set(LEGACY_LOCAL_CONFIG_KEY, JSON.stringify({ state: { selectedAgent: 'engineering', agentModels: { kortix: gpt } }, version: 0 }));

    await useLocalConfigStore.persist.rehydrate();
    expect(useLocalConfigStore.getState().selectedAgent).toBe('engineering');
    expect(useLocalConfigStore.getState().agentModels.kortix).toEqual(gpt);

    useLocalConfigStore.getState().setAgent('kortix');
    expect(JSON.parse(storage.get(LOCAL_CONFIG_KEY) ?? '{}').state.selectedAgent).toBe('kortix');
  });

  test('the new key wins over the legacy key', async () => {
    storage.set(LEGACY_LOCAL_CONFIG_KEY, JSON.stringify({ state: { selectedAgent: 'old' }, version: 0 }));
    storage.set(LOCAL_CONFIG_KEY, JSON.stringify({ state: { selectedAgent: 'new' }, version: 0 }));

    await useLocalConfigStore.persist.rehydrate();
    expect(useLocalConfigStore.getState().selectedAgent).toBe('new');
  });
});
