import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../../domain';
import { chatToResponses } from './request';

const descriptor = {
  provider: 'openai-codex',
  kind: 'openai-responses',
  baseUrl: 'https://chatgpt.test',
  apiKey: 'k',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-5.5',
} as UpstreamDescriptor;

// biome-ignore lint/suspicious/noExplicitAny: test reaches into the dynamic payload
type AnyJson = any;

describe('chatToResponses — vision', () => {
  test('preserves image_url parts as Responses input_image', () => {
    const payload = chatToResponses(
      {
        model: 'codex/gpt-5.5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
      descriptor,
    ) as AnyJson;

    const userMsg = payload.input.find((i: AnyJson) => i.role === 'user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toContainEqual({ type: 'input_text', text: 'what is this?' });
    expect(userMsg.content).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAAA',
    });
  });

  test('text-only user content collapses to a plain string', () => {
    const payload = chatToResponses(
      { model: 'codex/gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
      descriptor,
    ) as AnyJson;
    const userMsg = payload.input.find((i: AnyJson) => i.role === 'user');
    expect(userMsg.content).toBe('hello');
  });

  test('remote image URLs pass through too', () => {
    const payload = chatToResponses(
      {
        model: 'codex/gpt-5.5',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://ex.test/a.png' } }],
          },
        ],
      },
      descriptor,
    ) as AnyJson;
    const userMsg = payload.input.find((i: AnyJson) => i.role === 'user');
    expect(userMsg.content).toContainEqual({
      type: 'input_image',
      image_url: 'https://ex.test/a.png',
    });
  });
});
