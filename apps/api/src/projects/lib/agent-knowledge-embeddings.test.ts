import { describe, expect, test } from 'bun:test';
import { embedKnowledgeTexts } from './agent-knowledge-embeddings';

describe('embedKnowledgeTexts', () => {
  test('uses the managed default model and preserves response order', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await embedKnowledgeTexts(['first', 'second'], {
      apiKey: 'test-key',
      baseUrl: 'https://embedding.example.test/v1/',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({
          data: [
            { index: 1, embedding: Array(1536).fill(0.2) },
            { index: 0, embedding: Array(1536).fill(0.1) },
          ],
        });
      },
    });

    expect(requests[0]?.url).toBe('https://embedding.example.test/v1/embeddings');
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
      dimensions: 1536,
      encoding_format: 'float',
    });
    expect(result).toMatchObject({
      model: 'text-embedding-3-small',
      lexicalOnly: false,
      degradedReason: null,
    });
    expect(result.embeddings?.[0]?.[0]).toBe(0.1);
    expect(result.embeddings?.[1]?.[0]).toBe(0.2);
  });

  test('degrades visibly when credentials are unavailable', async () => {
    const result = await embedKnowledgeTexts(['knowledge'], { apiKey: undefined });
    expect(result).toEqual({
      embeddings: null,
      model: null,
      lexicalOnly: true,
      degradedReason: 'Embedding credentials are unavailable; lexical search remains active.',
    });
  });

  test('degrades visibly on provider and response errors', async () => {
    const providerFailure = await embedKnowledgeTexts(['knowledge'], {
      apiKey: 'test-key',
      fetchImpl: async () => new Response('quota exceeded', { status: 429 }),
    });
    expect(providerFailure.lexicalOnly).toBe(true);
    expect(providerFailure.degradedReason).toContain('429');

    const malformed = await embedKnowledgeTexts(['knowledge'], {
      apiKey: 'test-key',
      fetchImpl: async () => Response.json({ data: [{ index: 0, embedding: [1] }] }),
    });
    expect(malformed.lexicalOnly).toBe(true);
    expect(malformed.degradedReason).toContain('1536 dimensions');
  });
});
