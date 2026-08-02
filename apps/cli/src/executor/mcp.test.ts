import { describe, expect, test } from 'bun:test';
import type { ExecutorClient } from '@kortix/executor-sdk';
import { META_TOOLS, runMetaTool } from './mcp';

const executor = {} as ExecutorClient;

describe('executor MCP knowledge tools', () => {
  test('lists fixed search and read tools for every project', () => {
    const tools = META_TOOLS.map((tool) => tool.name);
    expect(tools).toContain('knowledge_search');
    expect(tools).toContain('knowledge_read');
    expect(META_TOOLS.find((tool) => tool.name === 'knowledge_search')?.readOnly).toBe(true);
    expect(META_TOOLS.find((tool) => tool.name === 'knowledge_read')?.readOnly).toBe(true);
  });

  test('runs knowledge search and read through the session-scoped runtime', async () => {
    const calls: unknown[] = [];
    const runtime = {
      searchKnowledge: async (query: string, limit?: number) => {
        calls.push({ kind: 'search', query, limit });
        return {
          results: [{ content: 'Cited evidence.', citation: { citation_id: 'citation-1' } }],
          mode: 'lexical',
          degraded_reason: null,
        };
      },
      readKnowledge: async (citationId: string) => {
        calls.push({ kind: 'read', citationId });
        return { content: 'Cited evidence.', citation: { citation_id: citationId } };
      },
    };

    const search = await runMetaTool(
      executor,
      'knowledge_search',
      { query: 'incident policy', limit: 5 },
      runtime,
    );
    expect(search.isError).toBe(false);
    expect(JSON.parse(search.content[0]!.text).results[0].citation.citation_id).toBe('citation-1');

    const read = await runMetaTool(
      executor,
      'knowledge_read',
      { citation_id: 'citation-1' },
      runtime,
    );
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.content[0]!.text).content).toBe('Cited evidence.');
    expect(calls).toEqual([
      { kind: 'search', query: 'incident policy', limit: 5 },
      { kind: 'read', citationId: 'citation-1' },
    ]);
  });

  test('rejects missing search and citation inputs without a backend call', async () => {
    const runtime = {
      searchKnowledge: async () => {
        throw new Error('must not run');
      },
      readKnowledge: async () => {
        throw new Error('must not run');
      },
    };
    expect((await runMetaTool(executor, 'knowledge_search', {}, runtime)).isError).toBe(true);
    expect((await runMetaTool(executor, 'knowledge_read', {}, runtime)).isError).toBe(true);
  });
});
