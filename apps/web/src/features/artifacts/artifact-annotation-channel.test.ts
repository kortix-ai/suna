import { expect, test } from 'bun:test';
import { connectArtifactAnnotationFrame } from './artifact-annotation-channel';

function fixture() {
  const events = new EventTarget();
  const loads = new EventTarget();
  const sent: unknown[] = [];
  const contentWindow = { postMessage: (value: unknown) => sent.push(value) };
  let claimed = true;
  const frame = Object.assign(loads, { contentWindow }) as unknown as HTMLIFrameElement;
  const slot = {
    isConnected: true,
    contains: (node: unknown) => claimed && node === frame,
  } as unknown as HTMLElement;
  const received: unknown[] = [];
  let resets = 0;
  const channel = connectArtifactAnnotationFrame(
    frame,
    slot,
    {
      onMessage: (message) => received.push(message),
      onLoad: () => resets++,
    },
    events as unknown as Window,
  );
  const send = (data: unknown, source: unknown = contentWindow) => {
    const event = Object.assign(new Event('message'), { data, source });
    events.dispatchEvent(event);
  };
  return {
    events,
    loads,
    sent,
    received,
    channel,
    send,
    steal: () => {
      claimed = false;
    },
    resets: () => resets,
  };
}
const ready = { kortix: 'annotate', v: 1, type: 'ready' };

test('only the claimed frame window can send validated annotation messages', () => {
  const f = fixture();
  f.send(ready, {});
  f.send({ ...ready, body: 'private' });
  f.send({ ...ready, type: 'delete' });
  expect(f.received).toHaveLength(0);
  f.send(ready);
  expect(f.received).toEqual([ready]);
  f.steal();
  f.send(ready);
  expect(f.received).toHaveLength(1);
  expect(f.channel.post({ kortix: 'annotate', v: 1, type: 'request_layout' })).toBe(false);
  f.channel.dispose();
  expect(f.sent).toHaveLength(0);
});

test('outgoing messages reject private fields and release stops listeners', () => {
  const f = fixture();
  expect(
    f.channel.post({
      kortix: 'annotate',
      v: 1,
      type: 'mode',
      mode: 'text',
      token: 'secret',
    } as never),
  ).toBe(false);
  expect(
    f.channel.post({
      kortix: 'annotate',
      v: 1,
      type: 'draw',
      revision: 1,
      pins: [],
      active: null,
      focus: false,
    }),
  ).toBe(true);
  f.loads.dispatchEvent(new Event('load'));
  expect(f.resets()).toBe(1);
  f.channel.dispose();
  f.send(ready);
  f.loads.dispatchEvent(new Event('load'));
  expect(f.received).toHaveLength(0);
  expect(f.resets()).toBe(1);
  expect(f.sent).toEqual([
    {
      kortix: 'annotate',
      v: 1,
      type: 'draw',
      revision: 1,
      pins: [],
      active: null,
      focus: false,
    },
    { kortix: 'annotate', v: 1, type: 'mode', mode: 'off' },
  ]);
});
