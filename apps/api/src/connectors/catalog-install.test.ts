import { describe, expect, test } from 'bun:test';
import { CatalogInstallError, catalogInstallDraft, catalogSlug } from './catalog-install';
import type { ConnectorCatalogDetail } from './connector-catalog';
import { specOperations } from './catalog-tools';

const detail: ConnectorCatalogDetail = {
  item: { id: 'kortix:stripe', kind: 'mcp', slug: 'stripe', name: 'Stripe', description: null, url: null, icon: null, domain: 'stripe.com', categories: [], feeds: ['kortix'], popularity: null },
  variants: [
    { id: 'kortix:stripe:mcp', kind: 'mcp', name: 'Stripe', url: 'https://mcp.stripe.com', docs: null, description: null, transports: ['http'], requiresAuth: true, command: null, connector: { provider: 'mcp', url: 'https://mcp.stripe.com', transport: 'http' }, oneClick: true, recommended: true },
    { id: 'composio:stripe', kind: 'composio', name: 'Stripe', url: null, docs: null, description: null, transports: [], requiresAuth: true, command: null, connector: null, oneClick: true, composio: { slug: 'stripe', name: 'Stripe', logo: null, description: null, categories: [], isNoAuth: false, connected: false } },
    { id: 'stripe-api', kind: 'openapi', name: 'Stripe API', url: null, docs: null, description: null, transports: [], requiresAuth: true, command: null, connector: { provider: 'openapi', spec: 'https://example.test/spec.json', auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' } } },
    { id: 'stripe-cli', kind: 'cli', name: 'Stripe CLI', url: null, docs: 'https://docs.example.test/cli', description: null, transports: [], requiresAuth: false, command: 'stripe', connector: null },
  ],
};

describe('install from the catalogue', () => {
  test('the recommended way by default, named after the app', () => {
    expect(catalogInstallDraft(detail).draft).toEqual({ slug: 'stripe', name: 'Stripe', provider: 'mcp', url: 'https://mcp.stripe.com', transport: 'http', create_only: true });
  });

  test('a chosen way and name: the managed toolkit, the API with its auth', () => {
    expect(catalogInstallDraft(detail, { way: 'composio:stripe', name: 'Billing (Stripe)' }).draft).toEqual({ slug: 'billing-stripe', name: 'Billing (Stripe)', provider: 'composio', app: 'stripe', account: 'default', create_only: true });
    expect(catalogInstallDraft(detail, { way: 'stripe-api', slug: 'stripe_api' }).draft).toMatchObject({ slug: 'stripe_api', provider: 'openapi', spec: 'https://example.test/spec.json', auth: { type: 'bearer', in: 'header' } });
  });

  test('a way Kortix cannot install, or no such way, is refused with the reason', () => {
    expect(() => catalogInstallDraft(detail, { way: 'stripe-cli' })).toThrow(CatalogInstallError);
    expect(() => catalogInstallDraft(detail, { way: 'nope' })).toThrow('"nope" is not a way to connect Stripe');
    expect(() => catalogInstallDraft(detail, { name: '!!!' })).toThrow('a letter or a digit');
    expect(catalogSlug('  Gmail — Support Inbox ')).toBe('gmail-support-inbox');
  });

  test('an OpenAPI document lists its operations as tools', () => {
    expect(
      specOperations({
        paths: {
          '/v1/customers': { get: { operationId: 'listCustomers', summary: 'List  customers' }, post: { summary: 'Create a customer' } },
          '/v1/charges/{id}': { delete: {}, parameters: [] },
        },
      }),
    ).toEqual([
      { name: 'listCustomers', description: 'List customers' },
      { name: 'POST /v1/customers', description: 'Create a customer' },
      { name: 'DELETE /v1/charges/{id}', description: '' },
    ]);
    expect(specOperations(null)).toEqual([]);
  });
});
