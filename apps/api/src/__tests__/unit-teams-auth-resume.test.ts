import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// A message parked behind the project picker replays only in the conversation
// it was sent in. A pick from anywhere else would run this sender's message
// where they never sent it.

let parkedRows: unknown[] = [];
let deletes = 0;
function chain(rows: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(rows));
  return c;
}
mock.module('../shared/db', () => ({
  db: {
    select: () => chain(parkedRows),
    delete: () => ({
      where: async () => {
        deletes += 1;
        return [];
      },
    }),
  },
  hasDatabase: () => true,
}));

const { consumePendingTeamsPickerMessage } = await import('../channels/teams/auth-resume');

const parked = { type: 'message', text: 'summarize the repo', conversation: { id: 'conv-a' } };

beforeEach(() => {
  parkedRows = [{ event: parked }];
  deletes = 0;
});
afterAll(() => mock.restore());

describe('consumePendingTeamsPickerMessage', () => {
  test('the pick in the same conversation replays the message once', async () => {
    const got = await consumePendingTeamsPickerMessage({ pendingId: 'p1', tenantId: 't1', conversationId: 'conv-a' });
    expect(got).toEqual(parked as never);
    expect(deletes).toBe(1);
  });

  test('a pick from another conversation replays nothing and leaves the message parked', async () => {
    const got = await consumePendingTeamsPickerMessage({ pendingId: 'p1', tenantId: 't1', conversationId: 'conv-b' });
    expect(got).toBeNull();
    expect(deletes).toBe(0);
  });
});
