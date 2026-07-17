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
  test('forces the Codex Responses backend to stream even for a non-streaming client', () => {
    const payload = chatToResponses(
      { model: 'codex/gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], stream: false },
      { ...descriptor, resolvedModel: 'gpt-5.6-sol' },
    );
    expect(payload.stream).toBe(true);
  });

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

// Found while investigating the max_tokens P0 (req_mro97uigg6rnflvf): a
// genuine reasoning+tools OpenAI request that route-kind.ts reroutes onto
// THIS transport previously carried NO output-token cap at all — neither
// `max_tokens` nor `max_completion_tokens` was ever translated into the
// Responses API's `max_output_tokens` field, so the client's budget was
// silently dropped rather than rejected (a distinct, quieter bug from the
// chat/completions 400 — no wire error, just an unbounded request).
describe('chatToResponses — max_output_tokens translation', () => {
  test('translates a chat/completions max_tokens into max_output_tokens', () => {
    const payload = chatToResponses(
      { model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32000 },
      descriptor,
    ) as AnyJson;
    expect(payload.max_output_tokens).toBe(32000);
  });

  test('translates an already-renamed max_completion_tokens into max_output_tokens', () => {
    const payload = chatToResponses(
      {
        model: 'openai/gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 8192,
      },
      descriptor,
    ) as AnyJson;
    expect(payload.max_output_tokens).toBe(8192);
  });

  test('prefers max_completion_tokens over max_tokens when both are present', () => {
    const payload = chatToResponses(
      {
        model: 'openai/gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999,
        max_completion_tokens: 111,
      },
      descriptor,
    ) as AnyJson;
    expect(payload.max_output_tokens).toBe(111);
  });

  test('omits max_output_tokens entirely when the caller sent no token budget', () => {
    const payload = chatToResponses(
      { model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] },
      descriptor,
    ) as AnyJson;
    expect('max_output_tokens' in payload).toBe(false);
  });
});
