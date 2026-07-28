import {
  OAuth2ApplicationInputSchema,
  OAuth2AuthorizationStartInputSchema,
  OAuth2DeviceAuthorizationStartInputSchema,
  OAuth2DiscoveryInputSchema,
} from '@kortix/api-contract';
import { executorConnectionProfiles, executorConnectors } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { ensureDefaultProfile } from '../../executor/credentials';
import {
  createAuthorizationCodeSession,
  createDeviceAuthorizationSession,
  discoverConfiguredOAuth2Application,
  loadOAuth2Application,
  oauth2ProfileStatus,
  pollDeviceAuthorizationSession,
  redactOAuth2Application,
  saveOAuth2Application,
} from '../../executor/oauth2-store';
import { PROJECT_ACTIONS } from '../../iam';
import { db } from '../../shared/db';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import { readBody } from '../lib/serializers';

function callbackUrl(requestUrl: string): string {
  return new URL('/v1/integrations/oauth2/callback', requestUrl).href;
}

function allowedRedirectUri(value: string | undefined, projectId: string): string | undefined {
  if (!value) return undefined;
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('redirect URI is invalid');
  }
  const configuredOrigin = new URL(config.FRONTEND_URL).origin;
  const allowedOrigins = new Set([
    configuredOrigin,
    'https://kortix.com',
    'https://www.kortix.com',
    'https://dev.kortix.com',
    'https://staging.kortix.com',
  ]);
  if (!allowedOrigins.has(uri.origin)) throw new Error('redirect URI origin is not allowed');
  if (!uri.pathname.startsWith(`/projects/${projectId}`) && uri.origin !== configuredOrigin) {
    throw new Error('redirect URI path is not allowed');
  }
  return uri.href;
}

async function loadMutableProfile(c: any, projectId: string, profileId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  const [profile] = await db
    .select({
      accountId: executorConnectionProfiles.accountId,
      projectId: executorConnectionProfiles.projectId,
      connectorId: executorConnectionProfiles.connectorId,
      profileId: executorConnectionProfiles.profileId,
      ownerType: executorConnectionProfiles.ownerType,
      ownerId: executorConnectionProfiles.ownerId,
    })
    .from(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.profileId, profileId),
        eq(executorConnectionProfiles.projectId, projectId),
        eq(executorConnectionProfiles.accountId, loaded.row.accountId),
      ),
    )
    .limit(1);
  if (!profile) return null;
  const serviceAccount = c.get('authType') === 'service_account';
  const mayManage = await projectCapabilityAllowed(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
  );
  const allowed =
    profile.ownerType === 'member'
      ? !serviceAccount && profile.ownerId === loaded.userId
      : mayManage;
  return allowed ? { loaded, profile } : null;
}

projectsApp.post('/:projectId/connectors/:slug/oauth2/profile', async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const mayManage = await projectCapabilityAllowed(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
  );
  if (!mayManage) return c.json({ error: 'Forbidden' }, 403);
  const [connector] = await db
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(
      and(
        eq(executorConnectors.accountId, loaded.row.accountId),
        eq(executorConnectors.projectId, projectId),
        eq(executorConnectors.slug, slug),
      ),
    )
    .limit(1);
  if (!connector) return c.json({ error: 'Connector not found' }, 404);
  const profileId = await ensureDefaultProfile({
    projectId,
    connectorId: connector.connectorId,
    createdBy: loaded.userId,
  });
  return c.json({ profile_id: profileId });
});

projectsApp.put('/:projectId/connector-profiles/:profileId/oauth2/application', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  const mutable = await loadMutableProfile(c, projectId, profileId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2ApplicationInputSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json(
      {
        error: parsed.error.issues[0]?.message ?? 'invalid OAuth2 application',
      },
      400,
    );
  }
  await saveOAuth2Application(mutable.profile, parsed.data, mutable.loaded.userId);
  return c.json({ ok: true });
});

projectsApp.get('/:projectId/connector-profiles/:profileId/oauth2/application', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  const mutable = await loadMutableProfile(c, projectId, profileId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const loaded = await loadOAuth2Application(profileId);
  if (!loaded) return c.json({ error: 'OAuth2 application is not configured' }, 404);
  return c.json({ application: redactOAuth2Application(loaded.application) });
});

projectsApp.post('/:projectId/connector-profiles/:profileId/oauth2/discover', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  if (!(await loadMutableProfile(c, projectId, profileId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  const parsed = OAuth2DiscoveryInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid discovery URL' }, 400);
  try {
    return c.json({
      metadata: await discoverConfiguredOAuth2Application(parsed.data.discovery_url),
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

projectsApp.post('/:projectId/connector-profiles/:profileId/oauth2/authorize', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  const mutable = await loadMutableProfile(c, projectId, profileId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2AuthorizationStartInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid authorization input' }, 400);
  try {
    const successRedirectUri = allowedRedirectUri(parsed.data.success_redirect_uri, projectId);
    const errorRedirectUri = allowedRedirectUri(parsed.data.error_redirect_uri, projectId);
    const started = await createAuthorizationCodeSession({
      profileId,
      initiatedBy: mutable.loaded.userId,
      callbackUrl: callbackUrl(c.req.url),
      scopes: parsed.data.scopes,
      successRedirectUri,
      errorRedirectUri,
    });
    return c.json({
      authorization_url: started.authorizationUrl,
      expires_at: new Date(started.expiresAt).toISOString(),
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

projectsApp.post('/:projectId/connector-profiles/:profileId/oauth2/device', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  const mutable = await loadMutableProfile(c, projectId, profileId);
  if (!mutable) return c.json({ error: 'Not found' }, 404);
  const parsed = OAuth2DeviceAuthorizationStartInputSchema.safeParse(await readBody(c));
  if (!parsed.success) return c.json({ error: 'invalid device authorization input' }, 400);
  try {
    const started = await createDeviceAuthorizationSession({
      profileId,
      initiatedBy: mutable.loaded.userId,
      scopes: parsed.data.scopes,
    });
    return c.json({
      session_id: started.sessionId,
      user_code: started.userCode,
      verification_uri: started.verificationUri,
      ...(started.verificationUriComplete
        ? { verification_uri_complete: started.verificationUriComplete }
        : {}),
      expires_at: new Date(started.expiresAt).toISOString(),
      interval_seconds: started.intervalSeconds,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

projectsApp.post(
  '/:projectId/connector-profiles/:profileId/oauth2/device/:sessionId',
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const profileId = c.req.param('profileId');
    const mutable = await loadMutableProfile(c, projectId, profileId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json(
        await pollDeviceAuthorizationSession({
          profileId,
          sessionId: c.req.param('sessionId'),
          initiatedBy: mutable.loaded.userId,
        }),
      );
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  },
);

projectsApp.get('/:projectId/connector-profiles/:profileId/oauth2/status', async (c: any) => {
  const projectId = c.req.param('projectId');
  const profileId = c.req.param('profileId');
  if (!(await loadMutableProfile(c, projectId, profileId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json(await oauth2ProfileStatus(profileId));
});
