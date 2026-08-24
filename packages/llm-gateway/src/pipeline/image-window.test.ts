import { describe, expect, test } from 'bun:test';
import { applyImageWindow } from './image-window';

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
    expect(applyImageWindow(body, { maxImages: 3, keepOnOverflow: 2 })).toEqual({
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
    expect(applyImageWindow(body, { maxImages: 4, keepOnOverflow: 2 })).toEqual({
      total: 5,
      dropped: 3,
    });
    const first = body.messages[0].content as Array<{ type: string; text?: string }>;
    const last = body.messages[2].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(first.map((p) => p.type)).toEqual(['text', 'text', 'text']);
    expect(first[1].text).toContain('3 older images removed');
    expect(last.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'image_url']);
    expect(last[2].image_url?.url).toBe('data:image/png;base64,4');
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

  test('maxImages 0 disables the window', () => {
    const body = { messages: [userWithImages(1, 2, 3)] };
    expect(applyImageWindow(body, { maxImages: 0, keepOnOverflow: 0 })).toEqual({
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
    expect(applyImageWindow(body, { maxImages: 1, keepOnOverflow: 1 })).toEqual({
      total: 0,
      dropped: 0,
    });
  });
});
