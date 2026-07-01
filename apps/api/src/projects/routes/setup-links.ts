/**
 * Agent-minted SETUP LINKS — the authenticated half.
 *
 * The in-sandbox agent (its KORTIX_EXECUTOR_TOKEN / KORTIX_CLI_TOKEN is a
 * session-scoped PAT, accepted by supabaseAuth) calls these to mint a
 * short-lived link it can hand to a human to (a) enter a project secret value,
 * or (b) 1-click connect a Pipedream app.
 * The link itself is resolved/submitted by the PUBLIC app at /v1/setup-links/*.
 *
 * See ../../setup-links/token.ts for the stateless token model and
 * .kortix/opencode/skills/kortix-system/references/kortix/credentials-and-setup-links.md
 * for the agent-facing flow.
 */
import { auth, errors, json } from '../../openapi';
import { config } from '../../config';
import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { loadPipedreamConnector } from '../../executor/db-deps';
import { pipedreamConfigured } from '../../executor/pipedream';
import { mintSetupLink, type SecretFieldSpec } from '../../setup-links/token';
import { isValidSecretName } from '../secrets';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { CODEX_AUTH_JSON_SECRET_NAME, normalizeString, readBody } from '../lib/serializers';
import { attemptRoute, attemptRouteSync, failJson, failNotFound, routeJson, runProjectRouteEffect } from './effect-workflows';

function frontendBase(): string {
  return (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// POST /v1/projects/:projectId/secret-requests
// Mint a link the human opens to enter one or more secret VALUES. The agent
// never sees the value — only the names it requested. Requires manage (the
// same gate as POST /secrets).
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/secret-requests',
    tags: ['secrets'],
    summary: 'POST /:projectId/secret-requests — mint a secret-entry link',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'A secret-entry link'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    return runProjectRouteEffect(c, Effect.gen(function* () {
      const body = yield* attemptRoute(() => readBody(c));
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'manage'));
      if (!loaded) return yield* failNotFound();

      // Accept `names: [...]` or a single `name`.
      const rawNames: unknown[] = Array.isArray(body.names)
        ? body.names
        : body.name != null
          ? [body.name]
          : [];
      const names = rawNames
        .map((n) => normalizeString(n)?.toUpperCase())
        .filter((n): n is string => !!n);
      if (names.length === 0) {
        return yield* failJson({ error: 'names is required (one or more env var names)' }, 400);
      }

      const labels = (body.labels ?? {}) as Record<string, unknown>;
      const descriptions = (body.descriptions ?? {}) as Record<string, unknown>;

      const fields: SecretFieldSpec[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (!isValidSecretName(name)) {
          return yield* failJson({ error: `"${name}" is not a valid env var name (A-Z, 0-9, _; max 64 chars)` }, 400);
        }
        if (name.startsWith('KORTIX_')) {
          return yield* failJson({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
        }
        if (name === CODEX_AUTH_JSON_SECRET_NAME) {
          return yield* failJson({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
        }
        fields.push({
          name,
          label: normalizeString(labels[name]) ?? undefined,
          description: normalizeString(descriptions[name]) ?? undefined,
        });
      }

      const scope = normalizeString(body.scope) === 'connector' ? 'connector' : 'runtime';
      const { token, expiresAt } = yield* attemptRouteSync(() => mintSetupLink(
        projectId,
        { kind: 'secret', fields, scope, uid: loaded.userId },
        { expiresInMinutes: typeof body.expires_in_minutes === 'number' ? body.expires_in_minutes : undefined },
      ));

      return routeJson({
        kind: 'secret',
        url: `${frontendBase()}/secret-intake/${token}`,
        names: fields.map((f) => f.name),
        scope,
        expires_at: new Date(expiresAt).toISOString(),
      });
    }));
  },
);

// POST /v1/projects/:projectId/connect-requests
// Mint a link the human opens to 1-click connect a Pipedream app (Quick
// Connect). Requires manage. The link is durable for its TTL; the public page
// mints a FRESH Pipedream connect token each time it's opened so it never
// hands out a stale (minutes-old) Pipedream token.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connect-requests',
    tags: ['connectors'],
    summary: 'POST /:projectId/connect-requests — mint a Pipedream Quick Connect link',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'A connect link'),
      ...errors(400, 404, 501),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    return runProjectRouteEffect(c, Effect.gen(function* () {
      const body = yield* attemptRoute(() => readBody(c));
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'manage'));
      if (!loaded) return yield* failNotFound();

      if (!pipedreamConfigured()) {
        return yield* failJson({ error: 'Pipedream is not configured on this deployment' }, 501);
      }

      const slug = normalizeString(body.slug);
      if (!slug) return yield* failJson({ error: 'slug is required' }, 400);

      const conn = yield* attemptRoute(() => loadPipedreamConnector(projectId, slug));
      if (!conn) {
        return yield* failJson(
          { error: `"${slug}" is not a connected-via-Pipedream connector on this project. Add it to kortix.toml first.` },
          404,
        );
      }

      const { token, expiresAt } = yield* attemptRouteSync(() => mintSetupLink(
        projectId,
        { kind: 'connector', slug, app: conn.app, mode: conn.mode, uid: loaded.userId },
        { expiresInMinutes: typeof body.expires_in_minutes === 'number' ? body.expires_in_minutes : undefined },
      ));

      return routeJson({
        kind: 'connector',
        url: `${frontendBase()}/connect/${token}`,
        slug,
        app: conn.app,
        expires_at: new Date(expiresAt).toISOString(),
      });
    }));
  },
);
