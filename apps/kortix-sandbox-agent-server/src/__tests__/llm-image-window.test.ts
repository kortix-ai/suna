import { describe, expect, test } from 'bun:test';
import { DEFAULT_IMAGE_WINDOW, applyInlineImageWindow, applyInlineImageWindowToText, imageCut, imageWindowFromEnv, isChatRequestPath } from '@/services/llm-proxy/llm-image-window';
import { applyImageWindow } from '../../../../packages/llm-gateway/src/pipeline/image-window';

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
    expect(imageWindowFromEnv({})).toEqual({ maxImages: 20, keepOnOverflow: 12, maxBytes: 22 * 1024 * 1024, keepBytesOnOverflow: 16 * 1024 * 1024 });
    expect(
      imageWindowFromEnv({
        KORTIX_LLM_MAX_INLINE_IMAGES: '6',
        KORTIX_LLM_IMAGE_KEEP_ON_OVERFLOW: '9',
        KORTIX_LLM_MAX_INLINE_IMAGE_BYTES: '1000',
        KORTIX_LLM_IMAGE_KEEP_BYTES_ON_OVERFLOW: '5000',
      }),
    ).toEqual({ maxImages: 6, keepOnOverflow: 6, maxBytes: 1000, keepBytesOnOverflow: 1000 });
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

// 2026-11-06: Claude Code puts every screenshot a tool returned inside a `tool_result` block and
// resends them all each step. The window counted none, and a real `claude` session passed
// Anthropic's 32 MB cap; every later turn of it failed with "Request too large".
describe('Claude Code and Responses shapes, and the byte cap', () => {
  const anthropicImage = (size: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(size) } });
  const claudeCodeBody = (reads: number, size: number) => ({
    model: 'claude-opus',
    messages: Array.from({ length: reads }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'mcp__kortix__read', input: { path: `shot_${i}.png` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'Read image file' }, anthropicImage(size)] }] },
    ]).flat(),
  });

  test('images inside a tool_result count, in the raw text and in the parsed body alike', () => {
    const body = claudeCodeBody(25, 100);
    const text = applyInlineImageWindowToText(JSON.stringify(body), { maxImages: 20, keepOnOverflow: 12 })!;
    expect(text).toMatchObject({ total: 25, dropped: 8 });
    const parsed = claudeCodeBody(25, 100);
    expect(applyInlineImageWindow(parsed, { maxImages: 20, keepOnOverflow: 12 })).toEqual({ total: 25, dropped: 8 });
    // Both paths write the same request: the 8 oldest tool images become the notice, the tool_result stays.
    expect(JSON.parse(text.text)).toEqual(parsed);
    const first = (parsed.messages[1]!.content[0] as { content: Array<{ type: string }> }).content;
    expect(first.map((p) => p.type)).toEqual(['text', 'text']);
    expect((parsed.messages[1]!.content[0] as { type: string }).type).toBe('tool_result');
  });

  test('a Responses function_call_output image counts', () => {
    const body = {
      input: Array.from({ length: 3 }, (_, i) => ({ type: 'function_call_output', call_id: `c${i}`, output: [{ type: 'input_image', image_url: `data:image/png;base64,${i}` }] })),
    };
    expect(applyInlineImageWindowToText(JSON.stringify(body), { maxImages: 2, keepOnOverflow: 1 })).toMatchObject({ total: 3, dropped: 1 });
  });

  test('the default byte cap keeps a 100-screenshot Claude Code request under 23 MB', () => {
    // ~0.33 MB per screenshot read, as the real `claude` run measured: 33 MB unwindowed.
    const body = claudeCodeBody(100, 330_000);
    const before = JSON.stringify(body);
    expect(before.length).toBeGreaterThan(32_000_000);
    const result = applyInlineImageWindowToText(before, { ...DEFAULT_IMAGE_WINDOW, maxImages: 0 })!;
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThan(23 * 1024 * 1024);
  });

  test('the newest image stays even over the byte cap by itself', () => {
    expect(imageCut([50, 500], { maxImages: 20, keepOnOverflow: 12, maxBytes: 300, keepBytesOnOverflow: 200 })).toBe(1);
    expect(imageCut([50, 500, 50], { maxImages: 20, keepOnOverflow: 12, maxBytes: 300, keepBytesOnOverflow: 200 })).toBe(2);
  });

  test('the cut matches the gateway window for the same image sizes', () => {
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let run = 0; run < 200; run++) {
      const sizes = Array.from({ length: 1 + rand(60) }, () => 30 + rand(120));
      const options = { maxImages: rand(2) ? 20 : 0, keepOnOverflow: 12, maxBytes: rand(2) ? 900 : 0, keepBytesOnOverflow: 600 };
      // The gateway measures a data URL by its length: build URLs of exactly these lengths.
      const gatewayBody = { messages: sizes.map((size) => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(size - 22)}` } }] })) };
      expect(imageCut(sizes, options)).toBe(applyImageWindow(gatewayBody, options).dropped);
    }
  });
});

