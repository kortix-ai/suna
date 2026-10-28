/**
 * The Enterprise entitlement, end to end (spec IAM-34).
 *
 * Enterprise is four features (`ENTERPRISE_FEATURES`, apps/api/src/types.ts):
 * sso, scim, rbac, auditAccess. One rule covers every Enterprise route
 * (ee/README.md): creating or changing Enterprise configuration, and reading
 * the audit log, answers 402 `entitlement_required` naming the feature unless
 * the account may use it. Reading configuration and removing it never answer
 * 402, so an account whose license ended can see and undo what it set up.
 *
 * The flow walks every route of the four features through Off → Demo → Off,
 * then proves the SCIM data plane follows the entitlement and that
 * organization branding is not an Enterprise feature.
 */
import { flow } from '../core/flow';
import type { Client } from '../core/client';
import type { FlowContext } from '../core/types';

type Feature = 'sso' | 'scim' | 'rbac' | 'auditAccess';
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Probe {
  feature: Feature;
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

/** A well-formed id that names nothing: the gate must answer before any lookup. */
const NONE = '00000000-0000-4000-8000-000000000034';

/** Routes that create or change Enterprise configuration, or read the audit log. */
const GATED: Probe[] = [
  { feature: 'sso', method: 'put', path: '/v1/accounts/:accountId/iam/sso/provider', body: {} },
  {
    feature: 'sso',
    method: 'post',
    path: '/v1/accounts/:accountId/iam/sso/provider/from-metadata',
    body: { name: 'Example', primary_domain: 'iam34.example.com', metadata_xml: '<x/>' },
  },
  { feature: 'sso', method: 'post', path: '/v1/accounts/:accountId/iam/sso/provider/verify-domain', body: {} },
  { feature: 'sso', method: 'post', path: '/v1/accounts/:accountId/iam/sso/mappings', body: {} },
  { feature: 'scim', method: 'post', path: '/v1/accounts/:accountId/iam/scim/tokens', body: { name: 'iam34' } },
  { feature: 'rbac', method: 'post', path: '/v1/accounts/:accountId/iam/groups', body: { name: 'iam34' } },
  { feature: 'rbac', method: 'patch', path: `/v1/accounts/:accountId/iam/groups/${NONE}`, body: { name: 'iam34' } },
  { feature: 'rbac', method: 'post', path: `/v1/accounts/:accountId/iam/groups/${NONE}/members`, body: {} },
  { feature: 'rbac', method: 'post', path: '/v1/accounts/:accountId/iam/roles', body: { name: 'iam34' } },
  { feature: 'rbac', method: 'patch', path: `/v1/accounts/:accountId/iam/roles/${NONE}`, body: { name: 'iam34' } },
  { feature: 'rbac', method: 'put', path: `/v1/accounts/:accountId/iam/roles/${NONE}/permissions`, body: { actions: [] } },
  { feature: 'rbac', method: 'post', path: '/v1/accounts/:accountId/iam/policies', body: {} },
  { feature: 'rbac', method: 'patch', path: `/v1/accounts/:accountId/iam/policies/${NONE}`, body: {} },
  { feature: 'rbac', method: 'post', path: '/v1/accounts/:accountId/iam/policies:bulk-import', body: {} },
  { feature: 'rbac', method: 'post', path: '/v1/projects/:projectId/group-grants', body: {} },
  { feature: 'rbac', method: 'patch', path: `/v1/projects/:projectId/group-grants/${NONE}`, body: {} },
  { feature: 'auditAccess', method: 'get', path: '/v1/accounts/:accountId/audit' },
  { feature: 'auditAccess', method: 'get', path: '/v1/accounts/:accountId/audit/activity' },
  { feature: 'auditAccess', method: 'get', path: '/v1/accounts/:accountId/audit/export' },
  { feature: 'auditAccess', method: 'post', path: '/v1/accounts/:accountId/audit/reconcile', body: {} },
  {
    feature: 'auditAccess',
    method: 'post',
    path: '/v1/accounts/:accountId/audit/webhooks',
    body: { url: 'https://iam34.example.com/hook' },
  },
  { feature: 'auditAccess', method: 'patch', path: `/v1/accounts/:accountId/audit/webhooks/${NONE}`, body: {} },
  {
    feature: 'auditAccess',
    method: 'post',
    path: `/v1/accounts/:accountId/audit/webhooks/${NONE}/deliveries/${NONE}/replay`,
    body: {},
  },
  { feature: 'auditAccess', method: 'get', path: '/v1/projects/:projectId/audit' },
];

/** Routes that read or remove Enterprise configuration: never a 402. */
const OPEN: Probe[] = [
  { feature: 'sso', method: 'get', path: '/v1/accounts/:accountId/iam/sso/provider' },
  { feature: 'sso', method: 'delete', path: '/v1/accounts/:accountId/iam/sso/provider' },
  { feature: 'sso', method: 'get', path: '/v1/accounts/:accountId/iam/sso/mappings' },
  { feature: 'sso', method: 'delete', path: `/v1/accounts/:accountId/iam/sso/mappings/${NONE}` },
  { feature: 'scim', method: 'get', path: '/v1/accounts/:accountId/iam/scim/tokens' },
  { feature: 'scim', method: 'delete', path: `/v1/accounts/:accountId/iam/scim/tokens/${NONE}` },
  { feature: 'rbac', method: 'get', path: '/v1/accounts/:accountId/iam/groups' },
  { feature: 'rbac', method: 'get', path: `/v1/accounts/:accountId/iam/groups/${NONE}` },
  { feature: 'rbac', method: 'delete', path: `/v1/accounts/:accountId/iam/groups/${NONE}` },
  { feature: 'rbac', method: 'get', path: `/v1/accounts/:accountId/iam/groups/${NONE}/members` },
  { feature: 'rbac', method: 'delete', path: `/v1/accounts/:accountId/iam/groups/${NONE}/members/${NONE}` },
  { feature: 'rbac', method: 'get', path: `/v1/accounts/:accountId/iam/groups/${NONE}/project-grants` },
  { feature: 'rbac', method: 'get', path: '/v1/accounts/:accountId/iam/roles' },
  { feature: 'rbac', method: 'delete', path: `/v1/accounts/:accountId/iam/roles/${NONE}` },
  { feature: 'rbac', method: 'get', path: `/v1/accounts/:accountId/iam/roles/${NONE}/permissions` },
  { feature: 'rbac', method: 'get', path: `/v1/accounts/:accountId/iam/roles/${NONE}/usage` },
  { feature: 'rbac', method: 'get', path: '/v1/accounts/:accountId/iam/actions' },
  { feature: 'rbac', method: 'get', path: '/v1/accounts/:accountId/iam/policies' },
  { feature: 'rbac', method: 'delete', path: `/v1/accounts/:accountId/iam/policies/${NONE}` },
  { feature: 'rbac', method: 'post', path: '/v1/accounts/:accountId/iam/policies:bulk-delete', body: { ids: [NONE] } },
  { feature: 'rbac', method: 'get', path: '/v1/projects/:projectId/group-grants' },
  { feature: 'rbac', method: 'delete', path: `/v1/projects/:projectId/group-grants/${NONE}` },
  { feature: 'auditAccess', method: 'get', path: '/v1/accounts/:accountId/audit/webhooks' },
  { feature: 'auditAccess', method: 'get', path: `/v1/accounts/:accountId/audit/webhooks/${NONE}/deliveries` },
  { feature: 'auditAccess', method: 'delete', path: `/v1/accounts/:accountId/audit/webhooks/${NONE}` },
];

/** The route key the manifest uses: the path with ids put back as params. */
function routeKey(p: Probe): string {
  const path = p.path
    .replace(/(iam\/groups|iam\/roles|iam\/policies|audit\/webhooks|group-grants|sso\/mappings|scim\/tokens)\/[0-9a-f-]{36}/g, (_m, s: string) =>
      `${s}/:${{ 'iam/groups': 'groupId', 'iam/roles': 'roleId', 'iam/policies': 'policyId', 'audit/webhooks': 'webhookId', 'group-grants': 'groupId', 'sso/mappings': 'mappingId', 'scim/tokens': 'tokenId' }[s]}`)
    .replace(/members\/[0-9a-f-]{36}/, 'members/:userId')
    .replace(/deliveries\/[0-9a-f-]{36}/, 'deliveries/:deliveryId');
  return `${p.method.toUpperCase()} ${path}`;
}

async function call(client: Client, p: Probe, params: { accountId: string; projectId: string }) {
  const opts = { params };
  if (p.method === 'get' || p.method === 'delete') return client[p.method](p.path, opts);
  return client[p.method](p.path, p.body ?? {}, opts);
}

/** Every gated route answers 402 naming its feature; every open route does not. */
async function assertOff(ctx: FlowContext, owner: Client, params: { accountId: string; projectId: string }) {
  const wrong: string[] = [];
  for (const p of GATED) {
    const r = await call(owner, p, params);
    const body = r.statusCode === 402 ? r.json<{ code?: string; entitlement?: string }>() : null;
    if (r.statusCode !== 402 || body?.code !== 'entitlement_required' || body.entitlement !== p.feature) {
      wrong.push(`${routeKey(p)} → ${r.statusCode} ${r.text().slice(0, 160)}`);
    }
  }
  for (const p of OPEN) {
    const r = await call(owner, p, params);
    if (r.statusCode === 402 || r.statusCode >= 500) wrong.push(`${routeKey(p)} → ${r.statusCode}`);
  }
  if (wrong.length) throw new Error(`Enterprise gate rule broken while Off:\n${wrong.join('\n')}`);
}

/** No route answers 402 once the account may use Enterprise. */
async function assertOn(owner: Client, params: { accountId: string; projectId: string }) {
  const wrong: string[] = [];
  for (const p of [...GATED, ...OPEN]) {
    const r = await call(owner, p, params);
    if (r.statusCode === 402 || r.statusCode >= 500) wrong.push(`${routeKey(p)} → ${r.statusCode} ${r.text().slice(0, 160)}`);
  }
  if (wrong.length) throw new Error(`Enterprise route still gated or failing in Demo:\n${wrong.join('\n')}`);
}

const DEMO = '/v1/accounts/:accountId/iam/enterprise-demo';

flow(
  'IAM-34',
  {
    domain: 'iam',
    routes: [
      ...new Set([
        ...GATED.map(routeKey),
        ...OPEN.map(routeKey),
        `GET ${DEMO}`,
        `PUT ${DEMO}`,
        'GET /v1/billing/account-state',
        'GET /scim/v2/accounts/:accountId/Users',
        'PUT /v1/accounts/:accountId/branding',
        'GET /v1/accounts/:accountId/branding',
      ]),
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id, projectId: project.id };
    const demo = (enabled: boolean) => owner.put(DEMO, { enabled }, { params: { accountId: team.id } });
    let scimToken = '';

    await ctx.step('a fresh account reports Enterprise off: account-state lists the four features false and branding true', async () => {
      (await owner.get(DEMO, { params: { accountId: team.id } })).status(200).body().has('$.state', 'off');
      (await owner.get('/v1/billing/account-state', { query: { account_id: team.id } }))
        .status(200)
        .body()
        .has('$.tier.entitlements.sso', false)
        .has('$.tier.entitlements.scim', false)
        .has('$.tier.entitlements.rbac', false)
        .has('$.tier.entitlements.auditAccess', false)
        .has('$.tier.entitlements.branding', true);
    });

    await ctx.step(
      `Off: each of the ${GATED.length} create/change/audit-read routes answers 402 entitlement_required naming its feature, and none of the ${OPEN.length} read/remove routes answers 402`,
      () => assertOff(ctx, owner, params),
    );

    await ctx.step('organization branding is not Enterprise: the OWNER sets an app name on the Off account → 200', async () => {
      (await owner.put('/v1/accounts/:accountId/branding', { app_name: 'IAM34' }, { params: { accountId: team.id } })).status(200);
      (await owner.get('/v1/accounts/:accountId/branding', { params: { accountId: team.id } }))
        .status(200)
        .body()
        .has('$.branding.app_name', 'IAM34')
        .has('$.entitled', true);
    });

    await ctx.step('the OWNER turns the Enterprise demo on → no Enterprise route answers 402', async () => {
      (await demo(true)).status(200).body().has('$.state', 'demo');
      await assertOn(owner, params);
    });

    await ctx.step('Demo: the OWNER mints a SCIM token and the SCIM API accepts it → 200', async () => {
      const r = await owner.post('/v1/accounts/:accountId/iam/scim/tokens', { name: 'iam34-live' }, { params: { accountId: team.id } });
      r.status(201);
      scimToken = r.json<{ secret: string }>().secret;
      (await ctx.client.withBearer(scimToken, 'SCIM').get('/scim/v2/accounts/:accountId/Users', { params: { accountId: team.id } })).status(200);
    });

    await ctx.step('turning the demo off gates every route again, exactly as before', async () => {
      (await demo(false)).status(200).body().has('$.state', 'off');
      await assertOff(ctx, owner, params);
    });

    await ctx.step('Off again: the SCIM token minted in Demo is refused by the SCIM API → 403', async () => {
      (await ctx.client.withBearer(scimToken, 'SCIM').get('/scim/v2/accounts/:accountId/Users', { params: { accountId: team.id } })).status(403);
    });
  },
);
