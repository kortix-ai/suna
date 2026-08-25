import { describe, expect, test } from 'bun:test';
import { applyInlineImageWindow, imageWindowFromEnv, isChatRequestPath } from '../llm-image-window';

const img = (n: number) => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${n}` },
});
const user = (...ids: number[]) => ({
  role: 'user',
  content: [{ type: 'text', text: 'shot' }, ...ids.map(img)],
});

describe('applyInlineImageWindow (in-sandbox)', () => {
  test('a request under the cap is untouched', () => {
    const body = { messages: [user(1, 2), user(3)] };
    const before = JSON.stringify(body);
    expect(applyInlineImageWindow(body, { maxImages: 3, keepOnOverflow: 2 })).toEqual({
      total: 3,
      dropped: 0,
    });
    expect(JSON.stringify(body)).toBe(before);
  });
  test('over the cap: keeps the newest, replaces older ones with a notice (OpenAI chat)', () => {
    const body = { messages: [user(1, 2), { role: 'assistant', content: 'ok' }, user(3, 4, 5)] };
    expect(applyInlineImageWindow(body, { maxImages: 4, keepOnOverflow: 2 })).toEqual({
      total: 5,
      dropped: 3,
    });
    const last = (body.messages[2]?.content ?? []) as Array<{ type: string }>;
    expect(last.map((p) => p.type)).toEqual(['text', 'text', 'image_url', 'image_url']);
  });
  test('Anthropic and Responses API shapes are covered', () => {
    const anthropic = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'image', source: {} },
          ],
        },
      ],
    };
    expect(applyInlineImageWindow(anthropic, { maxImages: 1, keepOnOverflow: 1 })).toEqual({
      total: 2,
      dropped: 1,
    });
    const responses = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'x' },
            { type: 'input_image', image_url: 'y' },
          ],
        },
      ],
    };
    expect(applyInlineImageWindow(responses, { maxImages: 1, keepOnOverflow: 1 })).toEqual({
      total: 2,
      dropped: 1,
    });
  });
  test('env: default window, override, and 0 disables', () => {
    expect(imageWindowFromEnv({})).toEqual({ maxImages: 20, keepOnOverflow: 12 });
    expect(
      imageWindowFromEnv({
        KORTIX_LLM_MAX_INLINE_IMAGES: '6',
        KORTIX_LLM_IMAGE_KEEP_ON_OVERFLOW: '9',
      }),
    ).toEqual({ maxImages: 6, keepOnOverflow: 6 });
    expect(imageWindowFromEnv({ KORTIX_LLM_MAX_INLINE_IMAGES: '0' })).toBeNull();
  });
  test('only model request paths are candidates', () => {
    expect(isChatRequestPath('/v1/llm/chat/completions')).toBe(true);
    expect(isChatRequestPath('/v1/llm/messages')).toBe(true);
    expect(isChatRequestPath('/v1/llm/responses')).toBe(true);
    expect(isChatRequestPath('/v1/llm/models')).toBe(false);
  });
});
