import { describe, expect, test } from 'bun:test';
import type { ConnectorSpec } from '../projects/connectors';
import type { GitBackedProject } from '../projects/git';
import {
  catalogPersistenceState,
  mcpCatalogCredentialError,
  rematerializeCatalogAfterCredentialUpdate,
  resolveCatalog,
  resolveMcpCatalogCredential,
  shouldReuseConnectorCatalog,
} from './sync';

const MCP_SPEC = {
  slug: 'records',
  path: 'kortix.yaml#connectors.records',
  name: 'Records',
  enabled: true,
  provider: 'mcp',
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  app: null,
  account: null,
  url: 'https://mcp.example.com/mcp',
  transport: 'http',
  endpoint: null,
  baseUrl: null,
  platform: null,
  spec: null,
  auth: {
    type: 'bearer',
    in: 'header',
    name: null,
    prefix: null,
    secret: null,
  },
  headers: { 'X-Tenant': 'tenant-123' },
  policies: [],
} satisfies ConnectorSpec;

const UNUSED_PROJECT = {} as GitBackedProject;

describe('MCP catalog materialization', () => {
  test('uses the execution credential path and normalizes authenticated tools', async () => {
    const requests: Array<{ headers: Record<string, string>; body?: string }> = [];
    const result = await resolveCatalog(UNUSED_PROJECT, MCP_SPEC, {
      credential: 'catalog-access-token',
      mcpFetchImpl: async (_url, init) => {
        requests.push({ headers: init.headers, body: init.body });
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                tools: [
                  {
                    name: 'queryRecords',
                    description: 'Query records',
                    inputSchema: { type: 'object' },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
            }),
        };
      },
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('expected one MCP catalog request');
    expect(request.headers.Authorization).toBe('Bearer catalog-access-token');
    expect(request.headers['X-Tenant']).toBe('tenant-123');
    expect(JSON.parse(request.body ?? '')).toMatchObject({
      method: 'tools/list',
    });
    expect(result).toMatchObject({
      server: 'https://mcp.example.com/mcp',
      actions: [{ path: 'queryrecords', risk: 'read' }],
    });
  });

  test('turns an upstream 401 into a useful catalog error without leaking the credential', async () => {
    const result = await resolveCatalog(UNUSED_PROJECT, MCP_SPEC, {
      credential: 'catalog-access-token',
      mcpFetchImpl: async () => ({
        status: 401,
        ok: false,
        text: async () => 'catalog-access-token is invalid',
      }),
    });

    expect(result.actions).toEqual([]);
    expect(result.error).toBe('MCP tools/list failed: HTTP 401');
    expect(catalogPersistenceState(true, result)).toEqual({
      status: 'error',
      lastError: 'MCP tools/list failed: HTTP 401',
    });
    expect(JSON.stringify(result)).not.toContain('catalog-access-token');
  });

  test('retries an existing active MCP connector whose catalog has zero actions', () => {
    expect(
      shouldReuseConnectorCatalog({
        force: false,
        hasExisting: true,
        existingStatus: 'active',
        provider: 'mcp',
        mcpHasActions: false,
        manifestMatches: true,
      }),
    ).toBe(false);
    expect(
      shouldReuseConnectorCatalog({
        force: false,
        hasExisting: true,
        existingStatus: 'active',
        provider: 'mcp',
        mcpHasActions: true,
        manifestMatches: true,
      }),
    ).toBe(true);
  });

  test('never reuses error rows or any catalog when force is requested', () => {
    const base = {
      hasExisting: true,
      provider: 'mcp' as const,
      mcpHasActions: true,
      manifestMatches: true,
    };
    expect(
      shouldReuseConnectorCatalog({
        ...base,
        force: false,
        existingStatus: 'error',
      }),
    ).toBe(false);
    expect(
      shouldReuseConnectorCatalog({
        ...base,
        force: true,
        existingStatus: 'active',
      }),
    ).toBe(false);
  });

  test('only project-default credential updates can rematerialize the shared MCP catalog', async () => {
    const calls: Array<{
      projectId: string;
      accountId: string;
      force?: boolean;
      credential?: string;
    }> = [];
    const sync = async (
      projectId: string,
      accountId: string,
      options: {
        force?: boolean;
        mcpCredentialOverrides?: ReadonlyMap<string, string>;
      } = {},
    ) => {
      calls.push({
        projectId,
        accountId,
        force: options.force,
        credential: options.mcpCredentialOverrides?.get('connector-1'),
      });
      return { synced: 1, errors: [] };
    };
    expect(
      await rematerializeCatalogAfterCredentialUpdate(
        {
          projectId: 'project-1',
          accountId: 'account-1',
          provider: 'mcp',
          ownerType: 'project',
          isDefault: true,
          connectorId: 'connector-1',
          credential: 'connection-access-token',
        },
        sync,
      ),
    ).toEqual({ synced: 1, errors: [] });
    expect(
      await rematerializeCatalogAfterCredentialUpdate(
        {
          projectId: 'project-1',
          accountId: 'account-1',
          provider: 'openapi',
          ownerType: 'project',
          isDefault: true,
        },
        sync,
      ),
    ).toBeUndefined();
    expect(
      await rematerializeCatalogAfterCredentialUpdate(
        {
          projectId: 'project-1',
          accountId: 'account-1',
          provider: 'mcp',
          ownerType: 'member',
          isDefault: true,
          connectorId: 'connector-1',
          credential: 'member-access-token',
        },
        sync,
      ),
    ).toBeUndefined();
    expect(
      await rematerializeCatalogAfterCredentialUpdate(
        {
          projectId: 'project-1',
          accountId: 'account-1',
          provider: 'mcp',
          ownerType: 'project',
          isDefault: false,
          connectorId: 'connector-1',
          credential: 'non-default-access-token',
        },
        sync,
      ),
    ).toBeUndefined();
    expect(calls).toEqual([
      {
        projectId: 'project-1',
        accountId: 'account-1',
        force: true,
        credential: 'connection-access-token',
      },
    ]);
  });

  test('a connection-specific refresh credential wins over the project default', async () => {
    let fallbackCalls = 0;
    const resolveDefault = async () => {
      fallbackCalls += 1;
      return 'project-default-token';
    };
    expect(
      await resolveMcpCatalogCredential(
        'connector-1',
        new Map([['connector-1', 'connection-access-token']]),
        resolveDefault,
      ),
    ).toBe('connection-access-token');
    expect(fallbackCalls).toBe(0);
    expect(await resolveMcpCatalogCredential('connector-1', undefined, resolveDefault)).toBe(
      'project-default-token',
    );
    expect(fallbackCalls).toBe(1);
  });

  test('credential-resolution errors retain safe OAuth codes and redact unknown messages', () => {
    expect(
      mcpCatalogCredentialError(new Error('OAuth2 token request failed (401): invalid_client')),
    ).toBe(
      'MCP catalog credential resolution failed: OAuth2 token request failed (401): invalid_client',
    );
    expect(
      mcpCatalogCredentialError(new Error('secret catalog-access-token failed to decrypt')),
    ).toBe('MCP catalog credential resolution failed');
  });
});
