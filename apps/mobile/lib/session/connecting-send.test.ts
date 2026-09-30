import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';

import { isOptimistic, useSyncStore } from '@/lib/opencode/sync-store';
import { useFailedSendStore } from './failed-sends';
import { queuePromptWhileWaking } from './connecting-send';

/**
 * The connecting view's composer was disabled: nothing could be sent until the
 * computer woke, although the server's prompt inbox holds a prompt durably and
 * delivers it once the computer is ready (the web sends there the same way).
 */

const ROOT = 'ses_root_1';
const originalFetch = globalThis.fetch;
const uuid = () => 'a4c0f7e2-1b3d-4e5f-8a9b-0c1d2e3f4a5b';

beforeEach(() => {
  useSyncStore.getState().reset();
  useFailedSendStore.setState({ bySession: {} } as never);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input = (text: string) => ({ projectId: 'p1', projectSessionId: 's1', rootId: ROOT, text, randomUUID: uuid });

describe('queuePromptWhileWaking', () => {
  test('a message sent while the computer wakes goes to the prompt inbox and shows at once', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ prompt: { id: 'prm_1', state: 'queued' } }, { status: 201 });
    }) as unknown as typeof fetch;

    expect(await queuePromptWhileWaking(input('Summarize the repo'))).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://test.local/v1/projects/p1/sessions/s1/prompts');
    expect(requests[0].body).toMatchObject({
      client_message_id: uuid(),
      parts: [{ type: 'text', text: 'Summarize the repo' }],
    });
    const [message] = useSyncStore.getState().messages[ROOT] ?? [];
    expect(message.info).toMatchObject({ id: requests[0].body.message_id, role: 'user', sessionID: ROOT });
    expect(message.parts).toMatchObject([{ type: 'text', text: 'Summarize the repo' }]);
    // The delivered echo, under the same message id, replaces it.
    expect(isOptimistic(message.info.id)).toBe(true);
  });

  test('a refused send stays in the thread as a failed send, never dropped', async () => {
    globalThis.fetch = mock(async () => Response.json({ error: 'nope' }, { status: 500 })) as unknown as typeof fetch;

    expect(await queuePromptWhileWaking(input('Summarize the repo'))).toBe(false);

    const [message] = useSyncStore.getState().messages[ROOT] ?? [];
    expect(message).toBeDefined();
    expect(isOptimistic(message.info.id)).toBe(false);
    expect(useFailedSendStore.getState().bySession[ROOT]?.[message.info.id]).toMatchObject({
      text: 'Summarize the repo',
      clientMessageId: uuid(),
      messageId: message.info.id,
    });
  });

  test('an empty message sends nothing', async () => {
    globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;
    expect(await queuePromptWhileWaking(input('   '))).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useSyncStore.getState().messages[ROOT]).toBeUndefined();
  });
});
