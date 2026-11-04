/**
 * The App route gated by a capability (./capabilities): the sign-in token.
 * An App without the capability answers 409 `app_capability_unsupported`.
 *
 *   POST   /projects/:projectId/apps/:appId/token   member_tokens   read
 *   GET    /projects/:projectId/apps/:appId/events/credentials   —   admin
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import { actorOf } from '../middleware/actor';
import { projectsApp } from '../projects/surface';
import { resolveAppViewerIdentity } from './viewer';
import { authorizedProject, capabilityRefusal, visibleApp } from './route-access';
import { TOKEN_TTL_SECONDS, mintAppToken } from './tokens';
import { appEventToken, appEventsUrl } from './events';

const AppParams = z.object({ projectId: z.string().uuid(), appId: z.string().uuid() });

const MemberToken = z
  .object({
    token: z.string().openapi({ description: 'ES256 JWT the App accepts as the signed-in member.' }),
    expires_at: z.string(),
  })
  .openapi('KortixAppMemberToken');

export function registerAppCapabilityRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/token', tags: ['apps'], summary: 'Mint a sign-in token for an App', ...auth,
      description:
        `Capability \`member_tokens\`. A ${TOKEN_TTL_SECONDS / 60}-minute ES256 JWT from the project issuer ` +
        '(`iss` = `<API origin>/v1/projects/{projectId}`, `aud` = the App id) naming the caller (`sub` = Kortix user id, ' +
        '`email`, `role`, `groups`). The App verifies it with its `auth` values. An agent session gets a token naming ' +
        'its agent (`sub` = service account id, `kind: "agent"`, no role, no groups), never the human who launched it.',
      request: { params: AppParams },
      responses: { 200: json(MemberToken, 'Token'), ...errors(403, 404, 409) },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, 'read');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const refusal = capabilityRefusal(c, 'member_tokens', null, app);
      if (refusal) return refusal;
      // An agent session's credential names the human who launched it. A token
      // for that id would carry the human's role and groups, so the agent gets
      // one naming its own service account, with no role and no groups.
      const { credential } = await actorOf(c, app.accountId);
      const minted = await mintAppToken(
        app,
        credential.kind === 'agent_session'
          ? { userId: credential.serviceAccountId, email: null, kind: 'agent' }
          : { userId: loaded.userId, ...(await resolveAppViewerIdentity(loaded.userId, app.accountId)) },
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ token: minted.token, expires_at: minted.expiresAt.toISOString() }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/events/credentials', tags: ['apps'], summary: "Read an App's event credentials", ...auth,
      description:
        'The URL and token an App uses to emit events (`KORTIX_APP_EVENTS_URL`, `KORTIX_APP_TOKEN`). Every App machine already ' +
        'has both. Read them to emit from code that runs elsewhere, such as your laptop while you develop the App. Needs project.app.admin.',
      request: { params: AppParams },
      responses: { 200: json(z.object({ url: z.string(), token: z.string() }).openapi('KortixAppEventCredentials'), 'Credentials'), ...errors(403, 404) },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, 'admin');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      c.header('Cache-Control', 'no-store');
      return c.json({ url: appEventsUrl(app), token: appEventToken(app.appId) }, 200);
    },
  );
}
