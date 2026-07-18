import { describe, expect, test } from 'bun:test';
import {
  discoverHttpAuthChallenge,
  discoverOpenApiAuth,
  discoverPostmanAuth,
  mergeAuthDiscoveries,
} from '../executor/auth-discovery';

describe('HTTP authentication challenge discovery', () => {
  test('normalizes bearer and basic challenges without retaining error details', () => {
    const bearer = discoverHttpAuthChallenge(
      'Bearer realm="api", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", error_description="do not retain me"',
      'MCP endpoint',
    );
    expect(bearer.recommended).toEqual({
      type: 'bearer',
      in: 'header',
      name: 'Authorization',
      prefix: 'Bearer',
    });
    expect(bearer.candidates[0]?.oauth?.protectedResourceMetadataUrl).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource',
    );
    expect(JSON.stringify(bearer)).not.toContain('do not retain me');
    expect(
      discoverHttpAuthChallenge('Basic realm="private"').recommended?.type,
    ).toBe('basic');
  });
});

describe('OpenAPI connector auth discovery', () => {
  test('uses operation coverage and preserves OAuth metadata without secret values', () => {
    const discovery = discoverOpenApiAuth(
      {
        openapi: '3.1.0',
        components: {
          securitySchemes: {
            privateApp: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            oauth: {
              type: 'oauth2',
              flows: {
                authorizationCode: {
                  authorizationUrl: 'https://example.com/oauth/authorize',
                  tokenUrl: 'https://example.com/oauth/token',
                  refreshUrl: 'https://example.com/oauth/refresh',
                  scopes: { 'crm.read': 'Read CRM', 'crm.write': 'Write CRM' },
                },
              },
            },
          },
        },
        security: [{ privateApp: [] }, { oauth: ['crm.read'] }],
        paths: {
          '/contacts': { get: { responses: {} }, post: { responses: {} } },
          '/public': { get: { security: [], responses: {} } },
          '/key-only': { get: { security: [{ apiKey: [] }], responses: {} } },
        },
      },
      'hubspot.openapi.json',
    );

    expect(discovery.status).toBe('detected');
    expect(discovery.recommended).toEqual({
      type: 'bearer',
      in: 'header',
      name: 'Authorization',
      prefix: 'Bearer',
    });
    expect(discovery.totalRequests).toBe(4);
    expect(
      discovery.candidates.find((candidate) => candidate.id === 'privateApp'),
    ).toMatchObject({
      scheme: 'bearer',
      supported: true,
      requestCount: 2,
    });
    expect(
      discovery.candidates.find((candidate) => candidate.id === 'apiKey'),
    ).toMatchObject({
      scheme: 'api_key',
      placement: 'header',
      parameterName: 'X-API-Key',
      requestCount: 1,
    });
    expect(
      discovery.candidates.find((candidate) => candidate.id === 'oauth'),
    ).toMatchObject({
      scheme: 'oauth2',
      supported: true,
      requestCount: 2,
      oauth: {
        authorizationUrl: 'https://example.com/oauth/authorize',
        tokenUrl: 'https://example.com/oauth/token',
        refreshUrl: 'https://example.com/oauth/refresh',
        scopes: ['crm.read', 'crm.write'],
      },
    });
  });

  test('supports Swagger 2 API keys and reports compound requirements', () => {
    const discovery = discoverOpenApiAuth(
      {
        swagger: '2.0',
        securityDefinitions: {
          queryKey: { type: 'apiKey', in: 'query', name: 'key' },
          basic: { type: 'basic' },
        },
        security: [{ queryKey: [], basic: [] }],
        paths: { '/things': { get: { responses: {} } } },
      },
      'swagger.json',
    );

    expect(discovery.status).toBe('ambiguous');
    expect(discovery.recommended).toEqual({
      type: 'custom',
      in: 'query',
      name: 'key',
      prefix: null,
    });
    expect(discovery.warnings.join('\n')).toContain(
      'requires multiple authentication schemes',
    );
  });
});

describe('Postman connector auth discovery', () => {
  test('honors collection/folder/request inheritance and explicit noauth', () => {
    const discovery = discoverPostmanAuth(
      {
        info: {
          name: 'Inherited auth',
          schema:
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        auth: {
          type: 'bearer',
          bearer: [
            { key: 'token', value: '{{private_token}}', type: 'string' },
          ],
        },
        item: [
          {
            name: 'Inherited',
            request: { method: 'GET', url: 'https://example.com/inherited' },
          },
          {
            name: 'API key folder',
            auth: {
              type: 'apikey',
              apikey: [
                { key: 'key', value: 'X-API-Key', type: 'string' },
                { key: 'value', value: '{{folder_key}}', type: 'string' },
                { key: 'in', value: 'header', type: 'string' },
              ],
            },
            item: [
              {
                name: 'Folder auth',
                request: { method: 'GET', url: 'https://example.com/key' },
              },
              {
                name: 'Public override',
                request: {
                  method: 'GET',
                  url: 'https://example.com/public',
                  auth: { type: 'noauth' },
                },
              },
            ],
          },
        ],
      },
      'collection.json',
    );

    expect(discovery.totalRequests).toBe(3);
    expect(discovery.recommended).toEqual({
      type: 'bearer',
      in: 'header',
      name: 'Authorization',
      prefix: 'Bearer',
    });
    expect(discovery.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: 'bearer',
          requestCount: 1,
          variables: ['private_token'],
        }),
        expect.objectContaining({
          scheme: 'api_key',
          placement: 'header',
          parameterName: 'X-API-Key',
          requestCount: 1,
          variables: ['folder_key'],
        }),
        expect.objectContaining({ scheme: 'none', requestCount: 1 }),
      ]),
    );
  });

  test('never returns literal credential values and retains unsupported schemes', () => {
    const discovery = discoverPostmanAuth(
      {
        info: {
          name: 'Digest collection',
          schema:
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        auth: {
          type: 'digest',
          digest: [
            { key: 'username', value: 'literal-user', type: 'string' },
            { key: 'password', value: 'literal-password', type: 'string' },
            { key: 'realm', value: '{{realm}}', type: 'string' },
          ],
        },
        item: [
          {
            name: 'Protected',
            request: { method: 'GET', url: 'https://example.com/private' },
          },
        ],
      },
      'digest.postman_collection.json',
    );

    expect(discovery.status).toBe('unsupported');
    expect(discovery.recommended).toBeNull();
    expect(discovery.candidates[0]).toMatchObject({
      scheme: 'digest',
      supported: false,
      variables: ['realm'],
      parameterNames: ['username', 'password', 'realm'],
    });
    expect(JSON.stringify(discovery)).not.toContain('literal-user');
    expect(JSON.stringify(discovery)).not.toContain('literal-password');
  });
});

test('merges mixed Postman-repository documents and ranks by total coverage', () => {
  const merged = mergeAuthDiscoveries([
    discoverOpenApiAuth(
      {
        openapi: '3.0.0',
        components: {
          securitySchemes: { hubspot: { type: 'http', scheme: 'bearer' } },
        },
        security: [{ hubspot: [] }],
        paths: {
          '/a': { get: { responses: {} } },
          '/b': { get: { responses: {} } },
        },
      },
      'specs/a.json',
    ),
    discoverPostmanAuth(
      {
        info: {
          name: 'Extra',
          schema:
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        auth: {
          type: 'apikey',
          apikey: [
            { key: 'key', value: 'hapikey' },
            { key: 'value', value: '{{hapikey}}' },
            { key: 'in', value: 'query' },
          ],
        },
        item: [
          {
            name: 'Legacy',
            request: { method: 'GET', url: 'https://example.com/legacy' },
          },
        ],
      },
      'legacy.collection.json',
    ),
  ]);

  expect(merged.totalRequests).toBe(3);
  expect(merged.recommended?.type).toBe('bearer');
  expect(merged.candidates).toHaveLength(2);
});
