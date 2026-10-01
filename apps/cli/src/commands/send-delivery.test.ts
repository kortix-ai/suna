import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../api/client.ts';

const SID = '3f2a9c1e-7b04-4d58-9a21-0c5e8d6b1f77';
let posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let postFails: ApiError | null = null;
let located = 0;
const client = {
  post: async (path: string, body: Record<string, unknown>) => {
    posts.push({ path, body });
    if (postFails) throw postFails;
    return { prompt_id: 'p1', message_id: 'msg_1', state: 'queued' };
  },
};
const real = await import('../command-helpers.ts');
mock.module('../command-helpers.ts', () => ({
  ...real,
  resolveProjectContext: async () => ({ client, projectId: 'proj-1', auth: { api_base: 'http://x/v1' } }),
  locateSessionAnywhere: async () => {
    located += 1;
    return null;
  },
}));
const { runSend } = await import('./send.ts');

beforeEach(() => {
  posts = [];
  postFails = null;
  located = 0;
});

// A worker reporting to its parent may post to it without being able to read
// it: the send must not look the session up first.
test('a session target posts into the current project without reading the session', async () => {
  expect(await runSend([SID, 'eu-central-1', '--json'])).toBe(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe(`/projects/proj-1/sessions/${SID}/prompts`);
  expect(posts[0]!.body.parts).toEqual([{ type: 'text', text: 'eu-central-1' }]);
  expect(located).toBe(0);
});

test('a 404 in the current project falls back to the cross-project lookup', async () => {
  postFails = new ApiError(404, 'Not found', { error: 'Not found' } as never);
  expect(await runSend([SID, 'hi'])).toBe(1);
  expect(located).toBe(1);
});
