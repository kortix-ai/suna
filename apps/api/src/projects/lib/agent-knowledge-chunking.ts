import { getEncoding } from 'js-tiktoken';

export interface KnowledgeLocator {
  page?: number;
  url?: string;
  heading?: string;
  row?: number;
}

export interface KnowledgeDocumentBlock {
  text: string;
  locator: KnowledgeLocator;
}

export interface KnowledgeChunkDraft {
  content: string;
  tokenCount: number;
  locator: KnowledgeLocator;
}

const encoder = getEncoding('cl100k_base');

export function chunkKnowledgeDocument(
  blocks: KnowledgeDocumentBlock[],
  options: { maxTokens?: number; overlapTokens?: number } = {},
): KnowledgeChunkDraft[] {
  const maxTokens = options.maxTokens ?? 800;
  const overlapTokens = options.overlapTokens ?? 120;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be positive.');
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('overlapTokens must be non-negative and smaller than maxTokens.');
  }

  const chunks: KnowledgeChunkDraft[] = [];
  const step = maxTokens - overlapTokens;
  for (const block of blocks) {
    const normalized = block.text.replace(/\r\n/g, '\n').trim();
    if (!normalized) continue;
    const tokens = encoder.encode(normalized);
    for (let start = 0; start < tokens.length; start += step) {
      const window = tokens.slice(start, start + maxTokens);
      const content = encoder.decode(window).trim();
      if (!content) continue;
      const stableTokens = encoder.encode(content);
      chunks.push({
        content,
        tokenCount: stableTokens.length,
        locator: { ...block.locator },
      });
      if (start + maxTokens >= tokens.length) break;
    }
  }
  return chunks;
}

export interface RankedCandidate {
  id: string;
  score: number;
}

export interface FusedCandidate {
  id: string;
  score: number;
  lexicalScore: number | null;
  vectorScore: number | null;
}

export function reciprocalRankFusion(
  lexical: RankedCandidate[],
  vector: RankedCandidate[],
  limit = 8,
  rankConstant = 60,
): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>();
  const add = (candidate: RankedCandidate, rank: number, kind: 'lexical' | 'vector') => {
    const current = fused.get(candidate.id) ?? {
      id: candidate.id,
      score: 0,
      lexicalScore: null,
      vectorScore: null,
    };
    current.score += 1 / (rankConstant + rank);
    if (kind === 'lexical') current.lexicalScore = candidate.score;
    else current.vectorScore = candidate.score;
    fused.set(candidate.id, current);
  };
  lexical.forEach((candidate, index) => add(candidate, index + 1, 'lexical'));
  vector.forEach((candidate, index) => add(candidate, index + 1, 'vector'));
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
}
