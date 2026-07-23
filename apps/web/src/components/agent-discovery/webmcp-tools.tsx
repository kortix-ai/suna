'use client';

import { useEffect } from 'react';

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

type ModelContext = {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => Promise<void>;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }

  interface Navigator {
    modelContext?: ModelContext;
  }
}

const KIND_VALUES = ['marketing', 'blog', 'docs', 'use-case'] as const;

export function registerWebMcpTools(modelContext: ModelContext, signal: AbortSignal) {
  const options = { signal };
  const tools: ModelContextTool[] = [
    {
      name: 'search_kortix_public_content',
      description: 'Search Kortix public documentation and product content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Words to match.' },
          kind: { type: 'string', enum: KIND_VALUES },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, kind }) => {
        const search = new URLSearchParams({ limit: '50' });
        if (
          typeof kind === 'string' &&
          KIND_VALUES.includes(kind as (typeof KIND_VALUES)[number])
        ) {
          search.set('kind', kind);
        }
        const response = await fetch(`/api/ai?${search}`);
        if (!response.ok) throw new Error(`Kortix content index returned ${response.status}`);
        const body = (await response.json()) as {
          data?: Array<{
            title?: string;
            description?: string | null;
            url?: string;
            markdown_url?: string | null;
          }>;
        };
        const needle = String(query).trim().toLocaleLowerCase();
        return (body.data ?? [])
          .filter((item) =>
            `${item.title ?? ''} ${item.description ?? ''}`
              .toLocaleLowerCase()
              .includes(needle),
          )
          .slice(0, 10);
      },
    },
    {
      name: 'read_kortix_public_page',
      description: 'Read a Kortix public page as Markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            pattern: '^/(?!/)',
            description: 'Kortix path from a search result.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async ({ path }) => {
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
          throw new Error('path must be an absolute Kortix path');
        }
        const response = await fetch(path, { headers: { Accept: 'text/markdown' } });
        if (!response.ok) throw new Error(`Kortix page returned ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('text/markdown')) {
          throw new Error(`Kortix page returned ${contentType || 'no content type'}`);
        }
        return { path, markdown: await response.text() };
      },
    },
  ];

  return Promise.all(tools.map((tool) => modelContext.registerTool(tool, options)));
}

export function WebMcpTools() {
  useEffect(() => {
    const modelContext = navigator.modelContext ?? document.modelContext;
    if (!modelContext?.registerTool) return;

    const controller = new AbortController();
    void registerWebMcpTools(modelContext, controller.signal).catch(() => {
      controller.abort();
    });

    return () => controller.abort();
  }, []);

  return null;
}
