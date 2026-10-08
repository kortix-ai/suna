/**
 * Public discovery for a backend's sign-in tokens, at the token issuer
 * (`<public API origin>/v1/backends/<id>`):
 *
 *   GET /v1/backends/:backendId/.well-known/openid-configuration
 *   GET /v1/backends/:backendId/jwks.json
 *
 * No auth: both answer only public keys and URLs, so any verifier (an own
 * server, an API gateway, a JOSE library) finds the key set from the token's
 * `iss` alone. A deleted backend, or one still on the placeholder issuer,
 * answers 404.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { projectBackends } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { errors, json, makeOpenApiApp } from '../openapi';
import { db } from '../shared/db';
import { decryptProjectSecret } from '../projects/surface';
import { backendJwks, backendOpenIdConfiguration } from './auth';

export const backendsPublicApp = makeOpenApiApp();

const Params = z.object({ backendId: z.string().uuid() });
// The key changes only with a new backend; an hour bounds a stale cache once rotation exists.
const CACHE = 'public, max-age=3600';

async function signer(backendId: string) {
  const [row] = await db
    .select({
      projectId: projectBackends.projectId,
      authKeyEnc: projectBackends.authKeyEnc,
      authIssuer: projectBackends.authIssuer,
    })
    .from(projectBackends)
    .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
    .limit(1);
  return row?.authKeyEnc && row.authIssuer ? { ...row, authKeyEnc: row.authKeyEnc, authIssuer: row.authIssuer } : null;
}

const notFound = { error: 'Not found' };

backendsPublicApp.openapi(
  createRoute({
    method: 'get', path: '/{backendId}/.well-known/openid-configuration', tags: ['backends'],
    summary: "A backend's token issuer metadata",
    description:
      'OpenID Provider metadata for the issuer of the backend\'s member tokens: `issuer` and `jwks_uri`. ' +
      'Public. For verifiers only: there is no authorization endpoint.',
    request: { params: Params },
    responses: {
      200: json(
        z.object({
          issuer: z.string(),
          jwks_uri: z.string(),
          id_token_signing_alg_values_supported: z.array(z.string()),
          subject_types_supported: z.array(z.string()),
          response_types_supported: z.array(z.string()),
          claims_supported: z.array(z.string()),
        }),
        'Issuer metadata',
      ),
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const row = await signer(c.req.valid('param').backendId);
    if (!row) return c.json(notFound, 404);
    c.header('Cache-Control', CACHE);
    return c.json(backendOpenIdConfiguration(row.authIssuer), 200);
  },
);

backendsPublicApp.openapi(
  createRoute({
    method: 'get', path: '/{backendId}/jwks.json', tags: ['backends'],
    summary: "A backend's token key set",
    description: 'The public ES256 key that signs the backend\'s member tokens, as a JSON Web Key Set. Public.',
    request: { params: Params },
    responses: {
      200: json(z.object({ keys: z.array(z.record(z.string(), z.string())) }), 'Key set'),
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const { backendId } = c.req.valid('param');
    const row = await signer(backendId);
    if (!row) return c.json(notFound, 404);
    c.header('Cache-Control', CACHE);
    return c.json(backendJwks(backendId, decryptProjectSecret(row.projectId, row.authKeyEnc)), 200);
  },
);
