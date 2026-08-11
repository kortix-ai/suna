import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { useChatSendStore } from './chat-send-store';

describe('chat send store aliases', () => {
  beforeEach(() => {
    useChatSendStore.setState({ senders: {} });
  });

  test('routes a workspace session alias to its mounted OpenCode chat', async () => {
    const sender = mock(async () => 'queued' as const);

    useChatSendStore.getState().registerSender('oc-session', sender, ['workspace-session']);

    await expect(
      useChatSendStore.getState().sendToSession('workspace-session', 'reconcile'),
    ).resolves.toBe('queued');
    expect(sender).toHaveBeenCalledWith('reconcile');
  });

  test('unregistering an OpenCode chat removes only aliases still owned by it', async () => {
    const first = mock(async () => 'sent' as const);
    const second = mock(async () => 'queued' as const);

    useChatSendStore.getState().registerSender('oc-first', first, ['workspace-session']);
    useChatSendStore.getState().registerSender('oc-second', second, ['workspace-session']);
    useChatSendStore.getState().unregisterSender('oc-first');

    await expect(
      useChatSendStore.getState().sendToSession('workspace-session', 'reconcile'),
    ).resolves.toBe('queued');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('reconcile');
  });
});
