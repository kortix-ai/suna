import { describe, expect, test } from 'bun:test';
import { __drainProxyBytesForTest, countProxyResponseBytes, proxyByteClass } from './proxy-bytes';

describe('proxy byte counter', () => {
  test('classifies the routes a direct path would carry', () => {
    expect(proxyByteClass(8000, '/global/event')).toBe('events');
    expect(proxyByteClass(8000, '/kortix/runtime/events?x=1')).toBe('events');
    expect(proxyByteClass(8000, '/kortix/runtime/messages/ses_1')).toBe('runtime');
    expect(proxyByteClass(8000, '/file/raw?path=a')).toBe('file');
    expect(proxyByteClass(8000, '/kortix/part/s/m/p')).toBe('file');
    expect(proxyByteClass(8000, '/kortix/health')).toBe('daemon');
    expect(proxyByteClass(3000, '/')).toBe('preview');
  });

  test('counts a sized body from its header and a streamed body as it flows', async () => {
    __drainProxyBytesForTest();
    const sized = countProxyResponseBytes(new Response('abcd', { headers: { 'content-length': '4' } }), 'runtime');
    expect(await sized.text()).toBe('abcd');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    const streamed = countProxyResponseBytes(new Response(stream, { status: 206 }), 'events');
    expect(streamed.status).toBe(206);
    expect((await streamed.arrayBuffer()).byteLength).toBe(8);
    expect(__drainProxyBytesForTest()).toEqual({
      runtime: { bytes: 4, responses: 1 },
      events: { bytes: 8, responses: 1 },
    });
  });
});
