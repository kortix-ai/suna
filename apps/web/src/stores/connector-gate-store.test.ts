import { beforeEach, describe, expect, test } from 'bun:test';

import { useConnectorGateStore } from './connector-gate-store';

const connectorProfiles = [
  {
    id: '653ca2f1-fe4c-4df4-932a-dc3045885ddb',
    slug: 'gmail-read',
    name: 'Gmail read only',
    authorization_strategy: 'user' as const,
  },
  {
    id: '79d15f28-e955-4f09-a08b-52e96fe97e3b',
    slug: 'slack-project',
    name: 'Slack project',
    authorization_strategy: 'project' as const,
  },
];

beforeEach(() => {
  useConnectorGateStore.setState({
    isOpen: false,
    projectId: null,
    connectorProfiles: [],
    retry: null,
  });
});

describe('useConnectorGateStore', () => {
  test('opens with every missing connector profile and the original retry callback', () => {
    let retryCount = 0;
    const retry = () => {
      retryCount += 1;
    };

    useConnectorGateStore
      .getState()
      .openConnectorGate({ projectId: 'project-1', connectorProfiles, retry });

    const state = useConnectorGateStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.projectId).toBe('project-1');
    expect(state.connectorProfiles).toEqual(connectorProfiles);
    expect(state.retry).toBe(retry);

    state.retry?.();
    expect(retryCount).toBe(1);
  });

  test('close clears every profile and the retry callback', () => {
    useConnectorGateStore.getState().openConnectorGate({
      projectId: 'project-1',
      connectorProfiles,
      retry: () => undefined,
    });

    useConnectorGateStore.getState().closeConnectorGate();

    const state = useConnectorGateStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.projectId).toBeNull();
    expect(state.connectorProfiles).toEqual([]);
    expect(state.retry).toBeNull();
  });
});
