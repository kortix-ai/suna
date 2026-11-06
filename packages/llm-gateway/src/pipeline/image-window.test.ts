import { describe, expect, test } from 'bun:test';
import { DEFAULT_IMAGE_WINDOW, IMAGE_WINDOW_NOTICE, applyImageWindow } from './image-window';

const img = (n: number) => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${n}` },
});
const userWithImages = (...ids: number[]) => ({
  role: 'user',
  content: [{ type: 'text', text: 'shot' }, ...ids.map(img)],
});

describe('applyImageWindow', () => {
  test('leaves a request at or under the cap untouched', () => {
    const body = { messages: [userWithImages(1, 2), userWithImages(3)] };
    const before = JSON.stringify(body);
    expect(applyImageWindow(body, { maxImages: 3, keepOnOverflow: 2 })).toMatchObject({
      total: 3,
      dropped: 0,
    });
    expect(JSON.stringify(body)).toBe(before);
  });

  test('over the cap: keeps the newest keepOnOverflow images, replaces older ones with a text notice', () => {
    const body = {
      messages: [
        userWithImages(1, 2),
        { role: 'assistant', content: 'ok' },
        userWithImages(3, 4, 5),
      ],
    };
    // The cut moves in steps of maxImages - keepOnOverflow (2): 5 images drop 2, keep 3.
    expect(applyImageWindow(body, { maxImages: 4, keepOnOverflow: 2 })).toMatchObject({
      total: 5,
      dropped: 2,
    });
    const first = body.messages[0].content as Array<{ type: string; text?: string }>;
    const last = body.messages[2].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(first.map((p) => p.type)).toEqual(['text', 'text', 'text']);
    expect(first[1].text).toContain('an older image was removed');
    expect(last.map((p) => p.type)).toEqual(['text', 'image_url', 'image_url', 'image_url']);
    expect(last[3].image_url?.url).toBe('data:image/png;base64,5');
  });

  test('hysteresis: after a prune the next maxImages-keepOnOverflow turns leave the prefix unchanged', () => {
    const body = { messages: [userWithImages(1, 2, 3, 4, 5)] };
    applyImageWindow(body, { maxImages: 4, keepOnOverflow: 2 });
    const prefix = JSON.stringify(body.messages);
    // One more image arrives: 3 images total, under the cap → no change to the prefix.
    body.messages.push(userWithImages(6));
    applyImageWindow(body, { maxImages: 4, keepOnOverflow: 2 });
    expect(JSON.stringify(body.messages.slice(0, 1))).toBe(prefix);
  });

  test('each request is windowed from the full history, as clients send it: the prefix holds until the next step', () => {
    // A client re-sends its whole history every request; the window must not slide per image.
    const request = (images: number) => {
      const body = { messages: Array.from({ length: images }, (_, i) => userWithImages(i + 1)) };
      applyImageWindow(body, { maxImages: 20, keepOnOverflow: 12 });
      return body.messages.map((message) => JSON.stringify(message));
    };
    const at21 = request(21);
    for (let images = 22; images <= 28; images++) {
      // Every message the 21-image request carried is byte-identical in the later one.
      expect(request(images).slice(0, 21)).toEqual(at21);
    }
    // The 29th image moves the cut by one step (8): the kept count drops back to 13.
    expect(request(29).filter((m) => m.includes('image_url')).length).toBe(13);
    // Never more than maxImages survive.
    for (let images = 21; images <= 60; images++) {
      const kept = request(images).filter((m) => m.includes('image_url')).length;
      expect(kept).toBeGreaterThan(12);
      expect(kept).toBeLessThanOrEqual(20);
    }
  });

  test('maxImages 0 disables the window', () => {
    const body = { messages: [userWithImages(1, 2, 3)] };
    expect(applyImageWindow(body, { maxImages: 0, keepOnOverflow: 0 })).toMatchObject({
      total: 3,
      dropped: 0,
    });
  });

  test('ignores string content and non-image parts', () => {
    const body = {
      messages: [
        { role: 'user', content: 'plain' },
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
      ],
    };
    expect(applyImageWindow(body, { maxImages: 1, keepOnOverflow: 1 })).toMatchObject({
      total: 0,
      dropped: 0,
    });
  });

  test('over the byte cap: keeps the newest images within keepBytesOnOverflow', () => {
    // Five 100-byte data URLs; cap 350, keep 250: the 4th image overflows, the window keeps 2.
    const sized = (size: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(size - 22)}` } });
    const body = { messages: [{ role: 'user', content: [100, 100, 100, 100, 100].map(sized) }] };
    const result = applyImageWindow(body, { maxImages: 20, keepOnOverflow: 12, maxBytes: 350, keepBytesOnOverflow: 250 });
    expect(result).toEqual({ total: 5, dropped: 2, bytes: 500, keptBytes: 300 });
    const parts = body.messages[0].content as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'image_url', 'image_url']);
    expect(parts[0].text).toBe(IMAGE_WINDOW_NOTICE);
  });

  test('the newest image stays even over the byte cap by itself; the next image moves it out', () => {
    const sized = (size: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(size - 22)}` } });
    const options = { maxImages: 20, keepOnOverflow: 12, maxBytes: 300, keepBytesOnOverflow: 200 };
    // The provider refuses it with request_too_large: the gateway never hides the image a person just sent.
    expect(applyImageWindow({ messages: [{ role: 'user', content: [sized(50), sized(500)] }] }, options)).toEqual({
      total: 2,
      dropped: 1,
      bytes: 550,
      keptBytes: 500,
    });
    expect(applyImageWindow({ messages: [{ role: 'user', content: [sized(50), sized(500), sized(50)] }] }, options)).toEqual({
      total: 3,
      dropped: 2,
      bytes: 600,
      keptBytes: 50,
    });
  });

  test('remote image URLs and inline data payloads: only inline bytes count', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(78)}` },
            { type: 'image', source: { type: 'base64', data: 'B'.repeat(200) } },
          ],
        },
      ],
    };
    expect(applyImageWindow(body, { maxImages: 0, keepOnOverflow: 0, maxBytes: 1000 })).toEqual({
      total: 3,
      dropped: 0,
      bytes: 300,
      keptBytes: 300,
    });
  });

  test('byte cap: the prefix holds until the next byte step, and no request exceeds maxBytes', () => {
    // A screenshot-reading agent: 4 images of ~36 units per step, cap 160, keep 100 (scaled 1:100k).
    const sizes = Array.from({ length: 200 }, (_, i) => 30 + ((i * 7) % 13));
    const sized = (size: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(size - 22)}` } });
    const request = (images: number) => {
      const body = { messages: sizes.slice(0, images).map((size) => ({ role: 'user', content: [sized(size)] })) };
      const result = applyImageWindow(body, { maxImages: 20, keepOnOverflow: 12, maxBytes: 160, keepBytesOnOverflow: 100 });
      return { result, messages: body.messages.map((m) => JSON.stringify(m)) };
    };
    let previous = request(1);
    let steps = 0;
    for (let images = 2; images <= 200; images++) {
      const next = request(images);
      expect(next.result.keptBytes).toBeLessThanOrEqual(160);
      expect(next.result.total - next.result.dropped).toBeGreaterThan(0);
      if (next.result.dropped === previous.result.dropped) {
        // No new prune: every message the previous request carried is byte-identical.
        expect(next.messages.slice(0, images - 1)).toEqual(previous.messages);
      } else steps += 1;
      previous = next;
    }
    // ~200 images of ~36 units with ~60 units of headroom: the cut moves every ~2 images, not every image.
    expect(steps).toBeLessThan(120);
  });

  test('default window: the 2026-11-02 request (twelve 3.6 MB PNGs, 43 MB) leaves at most 22 MiB of images', () => {
    // Each sheet a 1600x1200 PNG of ~2.7 MB, 3.6 MB as base64. Bedrock refused the 12-image request.
    const sheet = (n: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${String(n % 10).repeat(3_620_000)}` } });
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'review the sheets' }] },
        ...[0, 1, 2].map((step) => ({ role: 'user', content: [0, 1, 2, 3].map((i) => sheet(step * 4 + i)) })),
      ],
    };
    const result = applyImageWindow(body, DEFAULT_IMAGE_WINDOW);
    expect(result.total).toBe(12);
    expect(result.bytes).toBeGreaterThan(43_000_000);
    expect(result.keptBytes).toBeLessThanOrEqual(DEFAULT_IMAGE_WINDOW.maxBytes!);
    expect(JSON.stringify(body).length).toBeLessThan(31_000_000);
    // The newest step's sheets always survive.
    const newest = body.messages[3].content as Array<{ type: string }>;
    expect(newest.every((p) => p.type === 'image_url')).toBe(true);
  });
});
