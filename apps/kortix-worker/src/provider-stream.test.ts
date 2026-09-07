import { describe, expect, test } from 'bun:test';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { tapFirstToken } from './worker.ts';

describe('provider stream instrumentation', () => {
  test('records first content delta instead of the empty text-start marker', async () => {
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const inner = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_start', contentIndex: 0 };
        await deltaGate;
        yield { type: 'text_delta', contentIndex: 0, delta: 'visible' };
      },
      async result() {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: 'visible' }],
          stopReason: 'stop',
        };
      },
    } as unknown as AssistantMessageEventStream;
    const samples: number[] = [];
    const instrumented = tapFirstToken(inner, (sample) => samples.push(sample), {});
    const iterator = instrumented[Symbol.asyncIterator]();

    expect((await iterator.next()).value.type).toBe('text_start');
    expect(samples).toEqual([]);
    releaseDelta();
    expect((await iterator.next()).value.type).toBe('text_delta');
    expect(samples).toHaveLength(1);
    expect((await iterator.next()).done).toBe(true);
  });

  test('turns an iterator rejection into a terminal error result', async () => {
    const broken = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('provider stream exploded');
          },
        };
      },
      async result() {
        throw new Error('provider result exploded');
      },
    } as unknown as AssistantMessageEventStream;

    const instrumented = tapFirstToken(broken, () => {}, {
      api: 'anthropic-messages',
      provider: 'anthropic',
      id: 'claude-test',
    });
    const events: Array<{ type: string }> = [];
    for await (const event of instrumented) events.push(event);
    const result = await Promise.race([
      instrumented.result(),
      Bun.sleep(100).then(() => {
        throw new Error('instrumented result did not settle');
      }),
    ]);

    expect(events.at(-1)?.type).toBe('error');
    expect(result).toMatchObject({
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-test',
      stopReason: 'error',
      errorMessage: 'provider stream exploded',
    });
  });
});
