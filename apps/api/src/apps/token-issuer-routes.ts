/**
 * Public discovery for a project's Kortix sign-in tokens (./tokens.ts):
 *
 *   GET /v1/projects/:projectId/.well-known/openid-configuration
 *   GET /v1/projects/:projectId/jwks.json
 *
 * No auth: both answer only public keys and URLs, so any verifier (an App's
 * own server, an API gateway, a JOSE library) finds the key set from a token's
 * `iss` alone. Mounted before the authenticated projects router (app.ts). An
 * unknown project answers 404. A project that never minted a token answers an
 * empty key set: a public GET never creates a key.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { existingProjectSigner, openIdConfiguration, projectExists, projectIssuer, signerJwks } from './tokens';

export const tokenIssuerApp = makeOpenApiApp();

const Params = z.object({ projectId: z.string().uuid() });
// ponytail: an hour bounds a stale cache once key rotation exists; until then the key never changes.
const CACHE = 'public, max-age=3600';

const notFound = { error: 'Not found' };

tokenIssuerApp.openapi(
  createRoute({
    method: 'get', path: '/{projectId}/.well-known/openid-configuration', tags: ['apps'],
    summary: "A project's token issuer metadata",
    description:
      "OpenID Provider metadata for the issuer of a project's Kortix sign-in tokens: `issuer` and `jwks_uri`. " +
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
    const { projectId } = c.req.valid('param');
    if (!(await projectExists(projectId))) return c.json(notFound, 404);
    c.header('Cache-Control', CACHE);
    return c.json(openIdConfiguration(projectIssuer(projectId)), 200);
  },
);

tokenIssuerApp.openapi(
  createRoute({
    method: 'get', path: '/{projectId}/jwks.json', tags: ['apps'],
    summary: "A project's token key set",
    description:
      "The public ES256 key that signs a project's Kortix sign-in tokens, as a JSON Web Key Set. Public. " +
      'Empty until the project mints its first token.',
    request: { params: Params },
    responses: {
      200: json(z.object({ keys: z.array(z.record(z.string(), z.unknown())) }), 'Key set'),
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    if (!(await projectExists(projectId))) return c.json(notFound, 404);
    const signer = await existingProjectSigner(projectId);
    // An empty set must not be cached for an hour: the first token adds the key.
    c.header('Cache-Control', signer ? CACHE : 'no-store');
    return c.json(signerJwks(signer), 200);
  },
);
