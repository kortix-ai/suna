import { describe, expect, test } from 'bun:test';
import { getEncoding } from 'js-tiktoken';
import { chunkKnowledgeDocument, reciprocalRankFusion } from './agent-knowledge-chunking';

describe('chunkKnowledgeDocument', () => {
  test('uses 800-token windows with 120-token overlap and preserves locators', () => {
    const encoder = getEncoding('cl100k_base');
    const text = Array.from({ length: 1_500 }, (_, index) => `fact-${index}`).join(' ');
    const chunks = chunkKnowledgeDocument([
      { text, locator: { heading: 'Incident response', page: 3 } },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(encoder.encode(chunk.content).length).toBeLessThanOrEqual(800);
      expect(chunk.tokenCount).toBe(encoder.encode(chunk.content).length);
      expect(chunk.locator).toEqual({ heading: 'Incident response', page: 3 });
    }
    const firstTokens = encoder.encode(chunks[0]!.content);
    const secondTokens = encoder.encode(chunks[1]!.content);
    expect(secondTokens.slice(0, 120)).toEqual(firstTokens.slice(-120));
  });

  test('keeps heading sections as distinct chunks', () => {
    const chunks = chunkKnowledgeDocument([
      { text: 'Escalate P1 incidents immediately.', locator: { heading: 'P1' } },
      { text: 'Respond to P2 incidents in one hour.', locator: { heading: 'P2' } },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.locator.heading)).toEqual(['P1', 'P2']);
  });
});

describe('reciprocalRankFusion', () => {
  test('combines lexical and vector ranks deterministically', () => {
    const fused = reciprocalRankFusion(
      [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.8 },
        { id: 'c', score: 0.7 },
      ],
      [
        { id: 'b', score: 0.95 },
        { id: 'c', score: 0.85 },
        { id: 'd', score: 0.75 },
      ],
      8,
    );
    expect(fused.map((entry) => entry.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(fused[0]).toMatchObject({ lexicalScore: 0.8, vectorScore: 0.95 });
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });
});
