import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GET as getAgentSkillIndex } from '@/app/(public)/.well-known/agent-skills/index.json/route';
import { GET as getAgentSkill } from '@/app/(public)/.well-known/agent-skills/kortix-public-content/SKILL.md/route';
import { GET as getApiCatalog } from '@/app/(public)/.well-known/api-catalog/route';
import { GET as getMcpCard } from '@/app/(public)/.well-known/mcp/server-card.json/route';
import { GET as getOauthServer } from '@/app/(public)/.well-known/oauth-authorization-server/route';
import { GET as getProtectedResource } from '@/app/(public)/.well-known/oauth-protected-resource/route';
import { GET as getAuthMd } from '@/app/(public)/auth.md/route';
import { GET as getNegotiatedMarkdown } from '@/app/(public)/markdown-negotiation/route';
import { registerWebMcpTools } from '@/components/agent-discovery/webmcp-tools';
import { handlePublicContentMcp } from '@/lib/mcp/public-content-server';
import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';

describe('agent discovery documents', () => {
  test('publishes an RFC 9727 linkset with working Kortix relations', async () => {
    const response = getApiCatalog();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/linkset+json');
    expect(response.headers.get('Content-Type')).toContain('rfc9727');
    const body = (await response.json()) as any;
    expect(body.linkset).toHaveLength(1);
    expect(body.linkset[0].anchor).toBe('https://api.kortix.com/v1');
    expect(body.linkset[0]['service-desc'][0].href).toBe('https://api.kortix.com/v1/openapi.json');
    expect(body.linkset[0]['service-doc'][0].href).toBe('https://kortix.com/docs');
    expect(body.linkset[0].status[0].href).toBe('https://api.kortix.com/v1/health');
  });

  test('publishes truthful OAuth discovery and protected resource metadata', async () => {
    const oauth = (await getOauthServer().json()) as any;
    expect(oauth.issuer).toBe('https://jbriwassebxdwoieikga.supabase.co/auth/v1');
    expect(oauth.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(oauth.code_challenge_methods_supported).toEqual(['S256']);
    expect(oauth.agent_auth.identity_types_supported).toEqual(['user_authorization']);
    expect(oauth.agent_auth.user_authorization.credential_types_supported).toEqual([
      'kortix_personal_access_token',
    ]);

    const resource = (await getProtectedResource(
      new Request('https://kortix.com/.well-known/oauth-protected-resource'),
    ).json()) as any;
    expect(resource.resource).toBe('https://kortix.com');
    expect(resource.authorization_servers).toEqual([oauth.issuer]);
    expect(resource.bearer_methods_supported).toContain('header');

    const authMd = await getAuthMd().text();
    expect(authMd).toStartWith('# Kortix auth.md');
    expect(authMd).toContain('Kortix does not publish dynamic OAuth client registration');
    expect(authMd).toContain('Registration URI: /cli/authorize');
    expect(authMd).toContain('POST https://api.kortix.com/v1/accounts/tokens');
    expect(authMd).toContain('DELETE https://api.kortix.com/v1/accounts/tokens/{token_id}');
    expect(authMd).toContain('Authorization: Bearer <token>');
  });

  test('publishes a digest that matches the exact skill response bytes', async () => {
    const skillResponse = getAgentSkill();
    expect(skillResponse.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    const skill = await skillResponse.text();
    const index = (await getAgentSkillIndex().json()) as any;
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0].digest).toBe(
      `sha256:${createHash('sha256').update(skill).digest('hex')}`,
    );
  });

  test('publishes an MCP discovery card for the real public endpoint', async () => {
    const card = (await getMcpCard().json()) as any;
    expect(card.serverInfo.name).toBe('kortix-public-content');
    expect(card.transport).toEqual({
      type: 'streamable-http',
      endpoint: 'https://kortix.com/mcp',
    });
    expect(card.capabilities.tools).toBe(true);
    expect(card.capabilities.resources).toBe(true);
  });

  test('serves MCP initialize, list, and call responses', () => {
    const initialize = handlePublicContentMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }) as any;
    expect(initialize.result.serverInfo.name).toBe('kortix-public-content');
    expect(initialize.result.capabilities.tools.listChanged).toBe(false);

    const list = handlePublicContentMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }) as any;
    expect(list.result.tools.map((tool: any) => tool.name)).toEqual([
      'list_public_content',
      'get_public_markdown',
    ]);

    const call = handlePublicContentMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_public_markdown', arguments: { path: '/' } },
    }) as any;
    expect(call.result.isError).not.toBe(true);
    expect(call.result.content[0].text).toContain('# Kortix');
  });

  test('registers two read-only WebMCP tools with abort-controlled lifetimes', async () => {
    const registered: Array<{ tool: any; options: { signal?: AbortSignal } | undefined }> = [];
    const modelContext = {
      registerTool: async (tool: any, options?: { signal?: AbortSignal }) => {
        registered.push({ tool, options });
      },
    };
    const controller = new AbortController();
    await registerWebMcpTools(modelContext, controller.signal);
    expect(registered.map(({ tool }) => tool.name)).toEqual([
      'search_kortix_public_content',
      'read_kortix_public_page',
    ]);
    expect(registered.every(({ tool }) => tool.inputSchema.type === 'object')).toBe(true);
    expect(registered.every(({ options }) => options?.signal === controller.signal)).toBe(true);
    expect(registered.every(({ tool }) => typeof tool.execute === 'function')).toBe(true);
  });

  test('negotiates the homepage to a Markdown route before auth middleware', async () => {
    const request = new NextRequest('https://kortix.com/', {
      headers: { Accept: 'text/markdown' },
    });
    const rewritten = await middleware(request);
    expect(rewritten.headers.get('x-middleware-rewrite')).toBe(
      'https://kortix.com/markdown-negotiation?path=%2F',
    );

    const response = getNegotiatedMarkdown(
      new Request('https://kortix.com/markdown-negotiation?path=%2F'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Vary')).toBe('Accept');
    expect(await response.text()).toContain('# Kortix');
  });

  test('declares content signals and agent discovery routes in robots.txt', () => {
    const robots = fs.readFileSync(path.join(process.cwd(), 'public', 'robots.txt'), 'utf8');
    expect(robots).toContain('Content-Signal: ai-train=no, search=yes, ai-input=yes');
    expect(robots).toContain('Allow: /.well-known/');
    expect(robots).toContain('Allow: /auth.md');
    expect(robots).toContain('Allow: /mcp');
  });
});
