import { describe, expect, test } from 'bun:test';
import {
  AgentKnowledgeUrlError,
  fetchAgentKnowledgeUrl,
  isForbiddenKnowledgeAddress,
} from './agent-knowledge-url';

describe('knowledge URL SSRF guard', () => {
  test('blocks private, loopback, link-local, metadata, and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isForbiddenKnowledgeAddress(address)).toBe(true);
    }
    expect(isForbiddenKnowledgeAddress('93.184.216.34')).toBe(false);
    expect(isForbiddenKnowledgeAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  test('validates every redirect target before requesting it', async () => {
    const requested: string[] = [];
    await expect(
      fetchAgentKnowledgeUrl('https://public.example/start', {
        resolve: async (hostname) =>
          hostname === 'public.example'
            ? [{ address: '93.184.216.34', family: 4 as const }]
            : [{ address: '127.0.0.1', family: 4 as const }],
        request: async (url) => {
          requested.push(url.toString());
          return {
            status: 302,
            headers: { location: 'http://127.0.0.1/latest/meta-data' },
            body: new Uint8Array(),
          };
        },
      }),
    ).rejects.toMatchObject({ code: 'forbidden_target' });
    expect(requested).toEqual(['https://public.example/start']);
  });

  test('rejects oversized bodies and redirect loops with explicit errors', async () => {
    const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
    await expect(
      fetchAgentKnowledgeUrl('https://public.example/large', {
        resolve,
        maxBytes: 5,
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: new TextEncoder().encode('too large'),
        }),
      }),
    ).rejects.toMatchObject({ code: 'response_too_large' });

    let calls = 0;
    try {
      await fetchAgentKnowledgeUrl('https://public.example/loop', {
        resolve,
        maxRedirects: 1,
        request: async (url) => {
          calls += 1;
          return {
            status: 302,
            headers: { location: url.toString() },
            body: new Uint8Array(),
          };
        },
      });
      throw new Error('expected redirect failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentKnowledgeUrlError);
      expect((error as AgentKnowledgeUrlError).code).toBe('too_many_redirects');
    }
    expect(calls).toBe(2);
  });
});
