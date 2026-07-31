import { beforeEach, describe, expect, mock, test } from 'bun:test';

let inserted: Record<string, unknown> | null = null;

mock.module('./db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted = values;
        return {
          returning: async () => [{ eventId: 'event-1' }],
        };
      },
    }),
  },
}));

const { recordUsageEvent } = await import('./usage-events');

describe('recordUsageEvent', () => {
  beforeEach(() => {
    inserted = null;
  });

  test('leaves the legacy attribution column unset', async () => {
    const eventId = await recordUsageEvent({
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      actorUserId: 'user-1',
      provider: 'openai',
      model: 'gpt-5',
      route: '/v1/llm/chat/completions',
    });

    expect(eventId).toBe('event-1');
    expect(inserted).not.toHaveProperty('originRef');
  });
});
