// SCIM discovery route: /ServiceProviderConfig (capabilities discovery).
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors } from '../openapi';
import { scimRouter, ScimResource } from './app';

// ─── Discovery ────────────────────────────────────────────────────────────

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/ServiceProviderConfig',
    tags: ['scim'],
    summary: 'SCIM ServiceProviderConfig (capabilities discovery)',
    request: { params: z.object({ accountId: z.string() }) },
    responses: {
      200: json(ScimResource, 'ServiceProviderConfig'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  return c.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://docs.kortix.com/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Per-account SCIM token configured in Account Settings.',
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig' },
  });
  },
);
