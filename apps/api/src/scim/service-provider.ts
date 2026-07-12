// SCIM discovery route: /ServiceProviderConfig (capabilities discovery).
// Registers onto the shared scimRouter via side effect.

import { createRoute, z } from '@hono/zod-openapi';
import { scimError } from '../middleware/scim-auth';
import { errors, json } from '../openapi';
import { ScimResource, listResponse, scimRouter } from './app';

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

// ─── ResourceTypes + Schemas ────────────────────────────────────────────────
// Azure AD (and other strict SCIM clients) probe /ResourceTypes and /Schemas
// during connector setup to discover the User/Group endpoints and their
// attributes. Okta hardcodes this knowledge and never asked, so v1 skipped
// them — but Azure needs them, so we serve minimal, valid definitions.

const RESOURCE_TYPE_DEFS = [
  {
    name: 'User' as const,
    endpoint: '/Users',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
  },
  {
    name: 'Group' as const,
    endpoint: '/Groups',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  },
];

function resourceTypeFor(accountId: string, def: (typeof RESOURCE_TYPE_DEFS)[number]) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: def.name,
    name: def.name,
    endpoint: def.endpoint,
    description: `${def.name} resource`,
    schema: def.schema,
    meta: {
      resourceType: 'ResourceType',
      location: `/scim/v2/accounts/${accountId}/ResourceTypes/${def.name}`,
    },
  };
}

interface ScimAttr {
  name: string;
  type: string;
  multiValued: boolean;
  required: boolean;
  caseExact: boolean;
  mutability: string;
  returned: string;
  uniqueness: string;
  subAttributes?: ScimAttr[];
}

function attr(name: string, type: string, opts: Partial<ScimAttr> = {}): ScimAttr {
  return {
    name,
    type,
    multiValued: opts.multiValued ?? false,
    required: opts.required ?? false,
    caseExact: opts.caseExact ?? false,
    mutability: opts.mutability ?? 'readWrite',
    returned: 'default',
    uniqueness: opts.uniqueness ?? 'none',
    ...(opts.subAttributes ? { subAttributes: opts.subAttributes } : {}),
  };
}

const SCHEMA_DEFS = [
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: 'urn:ietf:params:scim:schemas:core:2.0:User',
    name: 'User',
    description: 'User Account',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server' }),
      attr('active', 'boolean'),
      attr('externalId', 'string'),
      attr('emails', 'complex', {
        multiValued: true,
        subAttributes: [attr('value', 'string'), attr('primary', 'boolean')],
      }),
      attr('name', 'complex', {
        subAttributes: [attr('givenName', 'string'), attr('familyName', 'string')],
      }),
    ],
  },
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
    name: 'Group',
    description: 'Group',
    attributes: [
      attr('displayName', 'string', { required: true }),
      attr('externalId', 'string'),
      attr('members', 'complex', {
        multiValued: true,
        subAttributes: [attr('value', 'string'), attr('display', 'string')],
      }),
    ],
  },
];

function schemaWithLocation(accountId: string, schema: (typeof SCHEMA_DEFS)[number]) {
  return {
    ...schema,
    meta: {
      resourceType: 'Schema',
      location: `/scim/v2/accounts/${accountId}/Schemas/${schema.id}`,
    },
  };
}

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/ResourceTypes',
    tags: ['scim'],
    summary: 'SCIM ResourceTypes (User + Group discovery)',
    request: { params: z.object({ accountId: z.string() }) },
    responses: { 200: json(ScimResource, 'ResourceTypes ListResponse'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    return c.json(listResponse(RESOURCE_TYPE_DEFS.map((d) => resourceTypeFor(accountId, d))));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/ResourceTypes/{id}',
    tags: ['scim'],
    summary: 'SCIM ResourceType by id',
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    responses: { 200: json(ScimResource, 'ResourceType'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const id = c.req.param('id');
    const def = RESOURCE_TYPE_DEFS.find((d) => d.name === id);
    if (!def) return scimError(c, 404, `Unknown ResourceType "${id}"`);
    return c.json(resourceTypeFor(accountId, def));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Schemas',
    tags: ['scim'],
    summary: 'SCIM Schemas (User + Group attribute definitions)',
    request: { params: z.object({ accountId: z.string() }) },
    responses: { 200: json(ScimResource, 'Schemas ListResponse'), ...errors(401, 403) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    return c.json(listResponse(SCHEMA_DEFS.map((s) => schemaWithLocation(accountId, s))));
  },
);

scimRouter.openapi(
  createRoute({
    method: 'get',
    path: '/accounts/{accountId}/Schemas/{id}',
    tags: ['scim'],
    summary: 'SCIM Schema by urn',
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    responses: { 200: json(ScimResource, 'Schema'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const id = c.req.param('id');
    const schema = SCHEMA_DEFS.find((s) => s.id === id);
    if (!schema) return scimError(c, 404, `Unknown Schema "${id}"`);
    return c.json(schemaWithLocation(accountId, schema));
  },
);
