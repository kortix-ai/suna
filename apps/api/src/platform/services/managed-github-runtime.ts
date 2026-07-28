import { randomUUID } from 'node:crypto';
import { platformSettings, projectGitConnections } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import { config } from '../../config';
import { getGitHubAppInstallationWithJwt } from '../../projects/github';
import { createNangoClient } from '../../projects/nango/client';
import { nangoWebhookUrlOverride } from '../../projects/nango/github-connection';
import { db } from '../../shared/db';
import {
  type ManagedGithubConnectionService,
  type ManagedGithubConnectionStore,
  createManagedGithubConnectionService,
  managedGithubEnvironmentId,
} from './managed-github-connection';
import {
  MANAGED_NANGO_GITHUB_SETTING_KEY,
  managedNangoGithubSettingSchema,
} from './managed-nango-github';

export function createManagedGithubConnectionStore(
  database: typeof db,
): ManagedGithubConnectionStore {
  return {
    getSelected: async () => {
      const [row] = await database
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(eq(platformSettings.key, MANAGED_NANGO_GITHUB_SETTING_KEY))
        .limit(1);
      const parsed = managedNangoGithubSettingSchema.safeParse(row?.value);
      return parsed.success ? parsed.data : null;
    },
    saveSelected: async (setting) => {
      const value = managedNangoGithubSettingSchema.parse(setting);
      await database
        .insert(platformSettings)
        .values({
          key: MANAGED_NANGO_GITHUB_SETTING_KEY,
          value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: { value, updatedAt: new Date() },
        });
    },
    markManagedProjectsUnavailable: async ({ connectionId, installationId }) => {
      const now = new Date();
      await database
        .update(projectGitConnections)
        .set({
          status: 'needs_reconnect',
          lastValidatedAt: now,
          lastErrorCode: 'github_reconnect_required',
          lastErrorMessage: 'The managed GitHub connection must be reconnected.',
          updatedAt: now,
        })
        .where(
          and(
            eq(projectGitConnections.provider, 'github'),
            eq(projectGitConnections.managed, true),
            or(
              eq(projectGitConnections.credentialRef, connectionId),
              eq(projectGitConnections.installationId, installationId),
            ),
          ),
        );
    },
  };
}

let productionService: ManagedGithubConnectionService | null = null;

function getProductionService(): ManagedGithubConnectionService {
  productionService ??= createManagedGithubConnectionService({
    client: createNangoClient({
      apiKey: config.NANGO_API_KEY,
      baseUrl: config.NANGO_BASE_URL,
    }),
    store: createManagedGithubConnectionStore(db),
    integrationId: config.NANGO_GITHUB_MANAGED_INTEGRATION_ID,
    environmentId: managedGithubEnvironmentId(config.INTERNAL_KORTIX_ENV, config.SUPABASE_URL),
    webhookUrlOverride: nangoWebhookUrlOverride(
      config.KORTIX_URL,
      config.INTERNAL_KORTIX_ENV === 'dev',
    ),
    createAttemptId: randomUUID,
    now: () => new Date(),
    getInstallation: ({ installationId, appJwt }) =>
      getGitHubAppInstallationWithJwt(installationId, appJwt),
  });
  return productionService;
}

export const managedGithubConnectionService: ManagedGithubConnectionService = {
  createConnectSession: (...args) => getProductionService().createConnectSession(...args),
  createReconnectSession: (...args) => getProductionService().createReconnectSession(...args),
  listCandidates: (...args) => getProductionService().listCandidates(...args),
  selectCandidate: (...args) => getProductionService().selectCandidate(...args),
  getStatus: (...args) => getProductionService().getStatus(...args),
  disconnectSelected: (...args) => getProductionService().disconnectSelected(...args),
  resolveSelectedCredential: (...args) => getProductionService().resolveSelectedCredential(...args),
};
