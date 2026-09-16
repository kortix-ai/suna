import { expect, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { recoverProviderOverflow } from './provider-overflow';

function failed(text = '', errorMessage = 'maximum context length is 8192 tokens') {
  const stream = createAssistantMessageEventStream();
  const partial = fauxAssistantMessage('');
  stream.push({ type: 'start', partial });
  if (text) stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: fauxAssistantMessage(text) });
  stream.push({ type: 'error', reason: 'error', error: fauxAssistantMessage(text, { stopReason: 'error', errorMessage }) });
  return stream;
}

function successful() {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: fauxAssistantMessage('') });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: 'recovered', partial: fauxAssistantMessage('recovered') });
  stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('recovered') });
  return stream;
}

async function collect(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test('an empty context rejection compacts once and exposes only the retried response', async () => {
  let recovered = 0;
  const { events, result } = await collect(recoverProviderOverflow(failed(), async () => {
    recovered++;
    return successful();
  }));
  expect(recovered).toBe(1);
  expect(events.map(e => e.type)).toEqual(['start', 'text_delta', 'done']);
  expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
});

test.each([
  ['visible partial', 'maximum context length is 8192 tokens'],
  ['', 'provider is unavailable'],
])('preserves output and non-overflow errors without retry: %s / %s', async (text, error) => {
  let recovered = 0;
  const { result } = await collect(recoverProviderOverflow(failed(text, error), async () => {
    recovered++;
    return successful();
  }));
  expect(recovered).toBe(0);
  expect(result.errorMessage).toBe(error);
});

test('a repeated rejection ends after one recovery attempt', async () => {
  let recovered = 0;
  const { result } = await collect(recoverProviderOverflow(failed(), async () => {
    recovered++;
    return failed();
  }));
  expect(recovered).toBe(1);
  expect(result.stopReason).toBe('error');
});

test('an unavailable recovery preserves the original error', async () => {
  const { result } = await collect(recoverProviderOverflow(failed(), async () => null));
  expect(result.errorMessage).toBe('maximum context length is 8192 tokens');
});

test('Stop during recovery settles as aborted without starting a replacement stream', async () => {
  const controller = new AbortController();
  const { result } = await collect(recoverProviderOverflow(failed(), async () => {
    controller.abort();
    controller.signal.throwIfAborted();
    return successful();
  }, controller.signal));
  expect(result.stopReason).toBe('aborted');
});

test('a failed summary becomes a terminal error instead of leaving the stream open', async () => {
  const { result } = await collect(recoverProviderOverflow(failed(), async () => {
    throw new Error('summary storage unavailable');
  }));
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toContain('summary storage unavailable');
});
