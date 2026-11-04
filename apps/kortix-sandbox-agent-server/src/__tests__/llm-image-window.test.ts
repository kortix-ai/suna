import { describe, expect, test } from 'bun:test';
import { applyInlineImageWindow, applyInlineImageWindowToText, imageWindowFromEnv, isChatRequestPath } from '@/services/llm-proxy/llm-image-window';

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
    // The cut moves in steps of maxImages - keepOnOverflow (2): 5 images drop 2, keep 3.
    expect(applyInlineImageWindow(body, { maxImages: 4, keepOnOverflow: 2 })).toEqual({
      total: 5,
      dropped: 2,
    });
    const last = (body.messages[2]?.content ?? []) as Array<{ type: string }>;
    expect(last.map((p) => p.type)).toEqual(['text', 'image_url', 'image_url', 'image_url']);
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
  test('the full history windowed per request keeps a byte-identical prefix until the next step', () => {
    const request = (images: number) => {
      const body = { messages: Array.from({ length: images }, (_, i) => user(i + 1)) };
      applyInlineImageWindow(body, { maxImages: 20, keepOnOverflow: 12 });
      return body.messages.map((message) => JSON.stringify(message));
    };
    const at21 = request(21);
    for (let images = 22; images <= 28; images++) expect(request(images).slice(0, 21)).toEqual(at21);
    expect(request(29).filter((m) => m.includes('image_url')).length).toBe(13);
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

describe('applyInlineImageWindowToText: the same window on the raw JSON, without parsing it', () => {
  const window = { maxImages: 20, keepOnOverflow: 12 };
  const anthropicImage = (n: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `iVBOR${'A'.repeat(50)}${n}==` }, ...(n % 3 ? {} : { cache_control: { type: 'ephemeral' } }) });
  // Shapes Claude Code and pi send: images at the message level and inside tool results,
  // text with quotes and escapes, tool schemas, nested arrays.
  const body = (images: number) => ({
    model: 'claude-opus-4',
    stream: true,
    system: [{ type: 'text', text: 'You are "Claude".\nUse \\ and é freely: {"type":"image"}' }],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' }, list: { type: 'array', items: [1, 2.5e3, true, null] } } } }],
    messages: Array.from({ length: images }, (_, n) => [
      { role: 'user', content: [{ type: 'text', text: `shot ${n} "quoted" \\ {"type":"image"}` }, anthropicImage(n)] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'read', input: { path: `s${n}.png` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: [anthropicImage(1000 + n)] }] },
    ]).flat(),
  });

  test('equals the parse-based window on every count, for pretty and compact JSON', () => {
    for (let images = 0; images <= 45; images++) {
      for (const space of [undefined, 2]) {
        const raw = JSON.stringify(body(images), null, space);
        const expected = JSON.parse(raw);
        const counted = applyInlineImageWindow(expected, window);
        const result = applyInlineImageWindowToText(raw, window);
        expect(result).not.toBeNull();
        expect({ total: result!.total, dropped: result!.dropped }).toEqual(counted);
        expect(JSON.parse(result!.text)).toEqual(expected);
        if (counted.dropped === 0) expect(result!.text).toBe(raw);
      }
    }
  });

  test('the Responses API shape, and a body it cannot read falls back (null)', () => {
    const responses = JSON.stringify({ input: Array.from({ length: 25 }, (_, n) => ({ role: 'user', content: [{ type: 'input_image', image_url: `data:${n}` }] })) });
    const expected = JSON.parse(responses);
    expect(applyInlineImageWindowToText(responses, window)!.dropped).toBe(applyInlineImageWindow(expected, window).dropped);
    expect(JSON.parse(applyInlineImageWindowToText(responses, window)!.text)).toEqual(expected);
    expect(applyInlineImageWindowToText('{"messages":[],"messages":[]}', window)).toBeNull();
    expect(applyInlineImageWindowToText('{"mess\\u0061ges":[]}', window)).toBeNull();
    expect(applyInlineImageWindowToText('[1,2]', window)).toBeNull();
    expect(applyInlineImageWindowToText('{"messages":[{"content":[{"type":"image"', window)).toBeNull();
  });

  test('a 15 MB request with 36 screenshots windows fast', () => {
    const shot = 'A'.repeat(400_000);
    const raw = JSON.stringify({ model: 'x', messages: Array.from({ length: 36 }, () => ({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] })) });
    const started = performance.now();
    const result = applyInlineImageWindowToText(raw, window)!;
    expect(result.dropped).toBe(16);
    expect(performance.now() - started).toBeLessThan(150);
  });
});
