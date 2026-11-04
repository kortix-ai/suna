import { beforeEach, describe, expect, mock, test } from 'bun:test';

const deleted: number[] = [];
mock.module('../shared/db', () => ({
  db: {
    delete: () => ({
      where: () => {
        deleted.push(1);
        return Promise.resolve();
      },
    }),
  },
}));

const { runWebhookWork, recordClaim } = await import('./webhook-work');
const { inflightCount, resetDrainForTests } = await import('../shared/drain');
const { getDiagnosticFields, runWithContext } = await import('../lib/request-context');

beforeEach(() => {
  deleted.length = 0;
  resetDrainForTests();
});

describe('runWebhookWork', () => {
  test('success keeps the claims and reports done', async () => {
    const outcome = await runWebhookWork('t', async () => recordClaim('k1'), { ackWaitMs: 500 });
    expect(outcome).toBe('done');
    expect(deleted).toHaveLength(0);
  });

  test('a fast failure releases the claims and reports failed', async () => {
    const outcome = await runWebhookWork(
      't',
      async () => {
        recordClaim('k1');
        throw new Error('db blip');
      },
      { ackWaitMs: 500 },
    );
    expect(outcome).toBe('failed');
    expect(deleted).toHaveLength(1);
  });

  test('a failure with no claims deletes nothing', async () => {
    await runWebhookWork('t', async () => { throw new Error('x'); }, { ackWaitMs: 500 });
    expect(deleted).toHaveLength(0);
  });

  test('slow work acks pending, stays counted for the drain, and releases when it fails later', async () => {
    let fail!: () => void;
    const outcome = await runWebhookWork(
      't',
      async () => {
        recordClaim('k1');
        await new Promise<void>((_, reject) => (fail = () => reject(new Error('late'))));
      },
      { ackWaitMs: 20 },
    );
    expect(outcome).toBe('pending');
    expect(inflightCount()).toBe(1);
    fail();
    await Bun.sleep(20);
    expect(inflightCount()).toBe(0);
    expect(deleted).toHaveLength(1);
  });

  test('ackWaitMs 0 returns at once', async () => {
    const outcome = await runWebhookWork('t', () => new Promise<void>(() => {}), { ackWaitMs: 0 });
    expect(outcome).toBe('pending');
  });

  test('the ack deadline names itself on the request line', async () => {
    let diagnostic: Record<string, string> = {};
    await runWithContext('POST', '/v1/webhooks/slack', async () => {
      await runWebhookWork('t', () => new Promise<void>(() => {}), { ackWaitMs: 20 });
      diagnostic = getDiagnosticFields();
    });
    expect(diagnostic["webhook_ack"]).toBe('deadline');
  });

  test('work that finishes first does not name a deadline', async () => {
    let diagnostic: Record<string, string> = {};
    await runWithContext('POST', '/v1/webhooks/slack', async () => {
      const outcome = await runWebhookWork('t', async () => {}, { ackWaitMs: 10_000 });
      expect(outcome).toBe('done');
      diagnostic = getDiagnosticFields();
    });
    expect(diagnostic["webhook_ack"]).toBeUndefined();
  });

  test('returning without waiting names no deadline either', async () => {
    let diagnostic: Record<string, string> = {};
    await runWithContext('POST', '/v1/webhooks/slack', async () => {
      await runWebhookWork('t', () => new Promise<void>(() => {}), { ackWaitMs: 0 });
      diagnostic = getDiagnosticFields();
    });
    expect(diagnostic["webhook_ack"]).toBeUndefined();
  });
});
