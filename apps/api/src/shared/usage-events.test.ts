import { beforeEach, describe, expect, mock, test } from 'bun:test';

let inserted: Record<string, unknown> | null = null;
let insertRows: Array<{ eventId: string }> = [{ eventId: 'event-1' }];
let existingRows: Array<{ eventId: string }> = [];
let conflictOptions: Record<string, unknown> | null = null;

mock.module('./db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted = values;
        const result = {
          returning: async () => insertRows,
          onConflictDoNothing: (options: Record<string, unknown>) => {
            conflictOptions = options;
            return { returning: async () => insertRows };
          },
        };
        return result;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => existingRows }),
      }),
    }),
  },
}));

const { recordUsageEvent } = await import('./usage-events');

const baseInput = {
  accountId: 'account-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  actorUserId: 'user-1',
  provider: 'openai',
  model: 'gpt-5',
  route: '/v1/llm/chat/completions',
};

describe('recordUsageEvent', () => {
  beforeEach(() => {
    inserted = null;
    insertRows = [{ eventId: 'event-1' }];
    existingRows = [];
    conflictOptions = null;
  });

  test('leaves the legacy attribution column unset', async () => {
    const eventId = await recordUsageEvent(baseInput);

    expect(eventId).toBe('event-1');
    expect(inserted).not.toHaveProperty('originRef');
  });

  test('returns the same durable row when a gateway request is recorded again', async () => {
    insertRows = [];
    existingRows = [{ eventId: 'event-existing' }];

    const eventId = await recordUsageEvent({
      ...baseInput,
      idempotencyKey: 'llm-gateway:req-1',
    });

    expect(eventId).toBe('event-existing');
    expect(inserted).toMatchObject({ idempotencyKey: 'llm-gateway:req-1' });
    expect(conflictOptions).not.toBeNull();
  });
});
