import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { supabaseAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/require-admin';
import { errors, json, makeOpenApiApp } from '../../openapi';
import { isNangoError } from '../../projects/nango/errors';
import type { AppEnv } from '../../types';
import type {
  ManagedGithubCandidate,
  ManagedGithubConnectionService,
} from '../services/managed-github-connection';
import { managedGithubConnectionService } from '../services/managed-github-runtime';

const candidateSchema = z.object({
  connection_id: z.string(),
  integration_id: z.string(),
  display_name: z.string(),
  installation_id: z.string().nullable(),
  owner: z
    .object({
      login: z.string(),
      type: z.literal('Organization'),
    })
    .nullable(),
  status: z.enum(['connected', 'needs_reconnect', 'error']),
  selected: z.boolean(),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string(), z.unknown()),
});

const sessionSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  connect_link: z.string(),
});

const connectionIdSchema = z.object({
  connection_id: z.string().trim().min(1).max(255),
});

const routeErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

const migrationErrorSchema = routeErrorSchema.extend({
  requires_human_oauth: z.literal(true),
  sdk_action: z.literal('createManagedGitHubConnectSession'),
});

function managedMigrationGuidance(message: string) {
  return {
    error: message,
    code: 'github_connection_required',
    requires_human_oauth: true as const,
    sdk_action: 'createManagedGitHubConnectSession' as const,
  };
}

function serializeCandidate(candidate: ManagedGithubCandidate) {
  return {
    connection_id: candidate.connectionId,
    integration_id: candidate.integrationId,
    display_name: candidate.displayName,
    installation_id: candidate.installationId,
    owner: candidate.owner,
    status: candidate.status,
    selected: candidate.selected,
    ...(candidate.repositorySelection
      ? { repository_selection: candidate.repositorySelection }
      : {}),
    permissions: candidate.permissions,
  };
}

function serializeSession(session: {
  token: string;
  expiresAt: string;
  connectLink: string;
}) {
  return {
    token: session.token,
    expires_at: session.expiresAt,
    connect_link: session.connectLink,
  };
}

function routeError(context: Context<AppEnv>, error: unknown): never {
  if (isNangoError(error)) {
    if (error.retryAfter) context.header('retry-after', error.retryAfter);
    return context.json(
      { error: error.message, code: error.code },
      error.status as ContentfulStatusCode,
    ) as never;
  }
  const message = error instanceof Error ? error.message : 'Managed GitHub request failed.';
  const status = message.includes('not found') || message.includes('No managed') ? 404 : 500;
  return context.json({ error: message }, status) as never;
}

export interface ManagedGithubRouterDependencies {
  service: ManagedGithubConnectionService;
  authMiddleware?: MiddlewareHandler<AppEnv>;
  adminMiddleware?: MiddlewareHandler<AppEnv>;
}

export function createManagedGithubRouter(dependencies: ManagedGithubRouterDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  const middleware: MiddlewareHandler<AppEnv>[] = [
    dependencies.authMiddleware ?? supabaseAuth,
    dependencies.adminMiddleware ?? requireAdmin,
  ];
  const legacyBodyRequest = {
    body: {
      content: {
        'application/json': {
          schema: z.object({}).passthrough(),
        },
      },
    },
  } as const;

  router.openapi(
    createRoute({
      method: 'post',
      path: '/manifest-start',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub App manifest adapter',
      middleware,
      request: legacyBodyRequest,
      responses: {
        409: json(migrationErrorSchema, 'Nango Connect required'),
        ...errors(401, 403),
      },
    }),
    async (context) =>
      context.json(managedMigrationGuidance('Legacy GitHub App manifest setup is disabled.'), 409),
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/app',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub App credential adapter',
      middleware,
      request: legacyBodyRequest,
      responses: {
        409: json(migrationErrorSchema, 'Nango Connect required'),
        ...errors(401, 403),
      },
    }),
    async (context) =>
      context.json(
        managedMigrationGuidance('Legacy GitHub App credential writes are disabled.'),
        409,
      ),
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/pat',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub PAT credential adapter',
      middleware,
      request: legacyBodyRequest,
      responses: {
        409: json(migrationErrorSchema, 'Nango Connect required'),
        ...errors(401, 403),
      },
    }),
    async (context) =>
      context.json(managedMigrationGuidance('Legacy managed GitHub PAT writes are disabled.'), 409),
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/manifest-callback',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub App manifest callback adapter',
      request: { query: z.object({}).passthrough() },
      responses: {
        409: json(migrationErrorSchema, 'Nango Connect required'),
      },
    }),
    async (context) =>
      context.json(
        managedMigrationGuidance('Legacy GitHub App manifest callbacks are disabled.'),
        409,
      ),
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/install-callback',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub App install callback adapter',
      request: { query: z.object({}).passthrough() },
      responses: {
        409: json(migrationErrorSchema, 'Nango Connect required'),
      },
    }),
    async (context) =>
      context.json(
        managedMigrationGuidance('Legacy GitHub App install callbacks are disabled.'),
        409,
      ),
  );

  router.openapi(
    createRoute({
      method: 'delete',
      path: '/',
      tags: ['platform'],
      summary: 'Deprecated managed GitHub disconnect adapter',
      middleware,
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Managed GitHub connection disconnected'),
        ...errors(401, 403, 404, 500),
      },
    }),
    async (context) => {
      try {
        await dependencies.service.disconnectSelected();
        return context.json({ ok: true as const }, 200);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'No managed GitHub connection is selected.'
        ) {
          return context.json({ ok: true as const }, 200);
        }
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/status',
      tags: ['platform'],
      summary: 'Selected managed GitHub Nango connection status',
      middleware,
      responses: {
        200: json(
          z.object({
            configured: z.boolean(),
            owner: z.string().nullable(),
            slug: z.null(),
            installation_id: z.string().nullable(),
            source: z.enum(['nango', 'none']),
            selected: candidateSchema.nullable(),
            candidates: z.array(candidateSchema),
          }),
          'Managed GitHub status',
        ),
        ...errors(401, 403, 500),
      },
    }),
    async (context) => {
      try {
        const status = await dependencies.service.getStatus();
        return context.json(
          {
            configured: status.configured,
            owner: status.selected?.owner?.login ?? null,
            slug: null,
            installation_id: status.selected?.installationId ?? null,
            source: status.selected ? ('nango' as const) : ('none' as const),
            selected: status.selected ? serializeCandidate(status.selected) : null,
            candidates: status.candidates.map(serializeCandidate),
          },
          200,
        );
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/connect-session',
      tags: ['platform'],
      summary: 'Create a managed GitHub Nango Connect session',
      middleware,
      request: { body: { content: { 'application/json': { schema: z.object({}) } } } },
      responses: {
        200: json(sessionSchema, 'Managed GitHub Connect session'),
        ...errors(401, 403, 500),
      },
    }),
    async (context) => {
      try {
        const session = await dependencies.service.createConnectSession(
          context.get('userId') as string,
        );
        return context.json(serializeSession(session), 200);
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/candidates',
      tags: ['platform'],
      summary: 'List environment-scoped managed GitHub Nango candidates',
      middleware,
      responses: {
        200: json(z.object({ candidates: z.array(candidateSchema) }), 'Managed GitHub candidates'),
        ...errors(401, 403, 500),
      },
    }),
    async (context) => {
      try {
        const candidates = await dependencies.service.listCandidates();
        return context.json({ candidates: candidates.map(serializeCandidate) }, 200);
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/select',
      tags: ['platform'],
      summary: 'Explicitly select a managed GitHub Nango candidate',
      middleware,
      request: {
        body: { content: { 'application/json': { schema: connectionIdSchema } } },
      },
      responses: {
        200: json(z.object({ candidate: candidateSchema }), 'Selected managed GitHub candidate'),
        400: json(routeErrorSchema, 'Invalid selection'),
        ...errors(401, 403, 404, 409, 500),
      },
    }),
    async (context) => {
      try {
        const body = context.req.valid('json');
        const candidate = await dependencies.service.selectCandidate(
          body.connection_id,
          context.get('userId') as string,
        );
        return context.json({ candidate: serializeCandidate(candidate) }, 200);
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/reconnect-session',
      tags: ['platform'],
      summary: 'Create a managed GitHub Nango reconnect session',
      middleware,
      request: {
        body: { content: { 'application/json': { schema: connectionIdSchema } } },
      },
      responses: {
        200: json(sessionSchema, 'Managed GitHub reconnect session'),
        400: json(routeErrorSchema, 'Invalid reconnect request'),
        ...errors(401, 403, 404, 500),
      },
    }),
    async (context) => {
      try {
        const body = context.req.valid('json');
        const session = await dependencies.service.createReconnectSession(
          body.connection_id,
          context.get('userId') as string,
        );
        return context.json(serializeSession(session), 200);
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  router.openapi(
    createRoute({
      method: 'delete',
      path: '/connection',
      tags: ['platform'],
      summary: 'Disconnect the selected managed GitHub Nango connection',
      middleware,
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Managed GitHub connection disconnected'),
        ...errors(401, 403, 404, 500),
      },
    }),
    async (context) => {
      try {
        await dependencies.service.disconnectSelected();
        return context.json({ ok: true as const }, 200);
      } catch (error) {
        return routeError(context, error);
      }
    },
  );

  return router;
}

export const managedGithubRouter = createManagedGithubRouter({
  service: managedGithubConnectionService,
});
