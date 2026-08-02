export const DEFAULT_KNOWLEDGE_EMBEDDING_MODEL = 'text-embedding-3-small';
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export interface KnowledgeEmbeddingResult {
  embeddings: number[][] | null;
  model: string | null;
  lexicalOnly: boolean;
  degradedReason: string | null;
}

export interface KnowledgeEmbeddingOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const lexicalFallback = (reason: string): KnowledgeEmbeddingResult => ({
  embeddings: null,
  model: null,
  lexicalOnly: true,
  degradedReason: reason,
});

export async function embedKnowledgeTexts(
  texts: string[],
  options: KnowledgeEmbeddingOptions,
): Promise<KnowledgeEmbeddingResult> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return lexicalFallback(
      'Embedding credentials are unavailable; lexical search remains active.',
    );
  }
  if (texts.length === 0) {
    return {
      embeddings: [],
      model: options.model ?? DEFAULT_KNOWLEDGE_EMBEDDING_MODEL,
      lexicalOnly: false,
      degradedReason: null,
    };
  }

  const model = options.model ?? DEFAULT_KNOWLEDGE_EMBEDDING_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: texts,
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
      return lexicalFallback(
        `Embedding provider returned ${response.status}${detail ? `: ${detail}` : ''}; lexical search remains active.`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
    };
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      return lexicalFallback(
        'Embedding provider returned an incomplete result; lexical search remains active.',
      );
    }
    const embeddings: Array<number[] | undefined> = Array(texts.length);
    for (const item of payload.data) {
      if (!Number.isInteger(item.index) || item.index! < 0 || item.index! >= texts.length) {
        return lexicalFallback(
          'Embedding provider returned an invalid result index; lexical search remains active.',
        );
      }
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
        !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        return lexicalFallback(
          `Embedding provider results must contain ${KNOWLEDGE_EMBEDDING_DIMENSIONS} dimensions; lexical search remains active.`,
        );
      }
      if (embeddings[item.index!]) {
        return lexicalFallback(
          'Embedding provider returned duplicate result indices; lexical search remains active.',
        );
      }
      embeddings[item.index!] = item.embedding;
    }
    if (embeddings.some((embedding) => !embedding)) {
      return lexicalFallback(
        'Embedding provider returned an incomplete result; lexical search remains active.',
      );
    }
    return {
      embeddings: embeddings as number[][],
      model,
      lexicalOnly: false,
      degradedReason: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return lexicalFallback(
      `Embedding provider failed: ${message.slice(0, 200)}; lexical search remains active.`,
    );
  }
}
