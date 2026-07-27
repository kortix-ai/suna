import { z } from 'zod';

export const MANAGED_NANGO_GITHUB_SETTING_KEY = 'managed_github_nango_connection';

export const managedNangoGithubSettingSchema = z
  .object({
    schemaVersion: z.literal(1),
    connectionId: z.string().min(1),
    integrationId: z.string().min(1),
    installationId: z.string().min(1),
    owner: z
      .object({
        login: z.string().min(1),
        type: z.literal('Organization'),
      })
      .strict(),
    status: z.enum(['connecting', 'connected', 'needs_reconnect', 'error', 'disconnected']),
    selectedByUserId: z.string().uuid(),
    selectedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ManagedNangoGithubSetting = z.infer<typeof managedNangoGithubSettingSchema>;
