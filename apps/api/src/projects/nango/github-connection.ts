import { z } from 'zod';
import type { NangoConnection, NangoTags } from './client';
import { invalidNangoResponse } from './errors';

const permissionsSchema = z.record(z.string(), z.unknown());

const appCredentialSchema = z
  .object({
    type: z.literal('APP'),
    access_token: z.string().min(1),
    expires_at: z.string().min(1).optional(),
    raw: z
      .object({
        permissions: permissionsSchema.optional(),
        repository_selection: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const userCredentialSchema = z
  .object({
    type: z.literal('OAUTH2'),
    access_token: z.string().min(1),
    expires_at: z.string().min(1).optional(),
    raw: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const accountCredentialSchema = z
  .object({
    type: z.literal('CUSTOM'),
    app: appCredentialSchema,
    user: userCredentialSchema,
    raw: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const accountTagsSchema = z
  .object({
    kortix_account_id: z.string().uuid(),
    kortix_user_id: z.string().uuid(),
    kortix_purpose: z.literal('account'),
    kortix_display_name: z.string().trim().min(1).max(255),
    kortix_connect_attempt_id: z.string().uuid(),
  })
  .passthrough();

const managedTagsSchema = z
  .object({
    kortix_user_id: z.string().uuid(),
    kortix_purpose: z.literal('managed'),
    kortix_display_name: z.string().trim().min(1).max(255),
    kortix_connect_attempt_id: z.string().uuid(),
  })
  .passthrough();

const installationIdSchema = z.union([z.string().min(1), z.number().int().positive()]);

export interface AccountNangoTagInput {
  accountId: string;
  userId: string;
  displayName: string;
  connectAttemptId: string;
}

export interface ManagedNangoTagInput {
  selectedByUserId: string;
  displayName: string;
  connectAttemptId: string;
}

export interface ParsedAccountNangoTags {
  accountId: string;
  userId: string;
  purpose: 'account';
  displayName: string;
  connectAttemptId: string;
}

export interface ParsedManagedNangoTags {
  userId: string;
  purpose: 'managed';
  displayName: string;
  connectAttemptId: string;
}

export interface AccountGithubCredential {
  mode: 'account';
  connectionId: string;
  integrationId: string;
  installationId: string;
  installationToken: string;
  installationTokenExpiresAt?: string;
  userToken: string;
  userTokenExpiresAt?: string;
  permissions: Record<string, unknown>;
  repositorySelection?: string;
  tags: NangoTags;
}

export interface ManagedGithubCredential {
  mode: 'managed';
  connectionId: string;
  integrationId: string;
  installationId: string;
  installationToken: string;
  installationTokenExpiresAt?: string;
  permissions: Record<string, unknown>;
  repositorySelection?: string;
  tags: NangoTags;
}

export interface GithubInstallationMetadata {
  installationId: string;
  ownerLogin: string;
  ownerType: 'User' | 'Organization';
  repositorySelection?: string;
  permissions: Record<string, unknown>;
  installationUrl?: string;
}

export function buildAccountNangoTags(input: AccountNangoTagInput): NangoTags {
  const parsed = accountTagsSchema.parse({
    kortix_account_id: input.accountId,
    kortix_user_id: input.userId,
    kortix_purpose: 'account',
    kortix_display_name: input.displayName,
    kortix_connect_attempt_id: input.connectAttemptId,
  });
  return {
    kortix_account_id: parsed.kortix_account_id,
    kortix_user_id: parsed.kortix_user_id,
    kortix_purpose: parsed.kortix_purpose,
    kortix_display_name: parsed.kortix_display_name,
    kortix_connect_attempt_id: parsed.kortix_connect_attempt_id,
  };
}

export function buildManagedNangoTags(input: ManagedNangoTagInput): NangoTags {
  const parsed = managedTagsSchema.parse({
    kortix_user_id: input.selectedByUserId,
    kortix_purpose: 'managed',
    kortix_display_name: input.displayName,
    kortix_connect_attempt_id: input.connectAttemptId,
  });
  return {
    kortix_user_id: parsed.kortix_user_id,
    kortix_purpose: parsed.kortix_purpose,
    kortix_display_name: parsed.kortix_display_name,
    kortix_connect_attempt_id: parsed.kortix_connect_attempt_id,
  };
}

export function parseAccountNangoTags(tags: unknown): ParsedAccountNangoTags | null {
  const result = accountTagsSchema.safeParse(tags);
  if (!result.success) return null;
  return {
    accountId: result.data.kortix_account_id,
    userId: result.data.kortix_user_id,
    purpose: result.data.kortix_purpose,
    displayName: result.data.kortix_display_name,
    connectAttemptId: result.data.kortix_connect_attempt_id,
  };
}

export function parseManagedNangoTags(tags: unknown): ParsedManagedNangoTags | null {
  const result = managedTagsSchema.safeParse(tags);
  if (!result.success) return null;
  return {
    userId: result.data.kortix_user_id,
    purpose: result.data.kortix_purpose,
    displayName: result.data.kortix_display_name,
    connectAttemptId: result.data.kortix_connect_attempt_id,
  };
}

export function nangoWebhookUrlOverride(
  kortixUrl: string | null | undefined,
  localDevelopment: boolean,
): string | undefined {
  if (!localDevelopment || !kortixUrl) return undefined;
  try {
    const url = new URL(kortixUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/webhooks/nango`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function installationId(connection: NangoConnection): string {
  const result = installationIdSchema.safeParse(connection.connectionConfig.installation_id);
  if (!result.success) throw invalidNangoResponse();
  return String(result.data);
}

function validateConnectionIdentity(
  connection: NangoConnection,
  expected: { integrationId: string; provider: 'github-app-oauth' | 'github-app' },
): void {
  if (
    connection.integrationId !== expected.integrationId ||
    connection.provider !== expected.provider ||
    connection.errors.some((error) => error.type === 'auth')
  ) {
    throw invalidNangoResponse();
  }
}

export function decodeAccountGithubConnection(
  connection: NangoConnection,
  expected: { integrationId: string },
): AccountGithubCredential {
  validateConnectionIdentity(connection, {
    integrationId: expected.integrationId,
    provider: 'github-app-oauth',
  });
  const credentials = accountCredentialSchema.safeParse(connection.credentials);
  if (!credentials.success) throw invalidNangoResponse();

  return {
    mode: 'account',
    connectionId: connection.connectionId,
    integrationId: connection.integrationId,
    installationId: installationId(connection),
    installationToken: credentials.data.app.access_token,
    ...(credentials.data.app.expires_at
      ? { installationTokenExpiresAt: credentials.data.app.expires_at }
      : {}),
    userToken: credentials.data.user.access_token,
    ...(credentials.data.user.expires_at
      ? { userTokenExpiresAt: credentials.data.user.expires_at }
      : {}),
    permissions: credentials.data.app.raw.permissions ?? {},
    ...(credentials.data.app.raw.repository_selection
      ? { repositorySelection: credentials.data.app.raw.repository_selection }
      : {}),
    tags: connection.tags,
  };
}

export function decodeManagedGithubConnection(
  connection: NangoConnection,
  expected: { integrationId: string },
): ManagedGithubCredential {
  validateConnectionIdentity(connection, {
    integrationId: expected.integrationId,
    provider: 'github-app',
  });
  const credentials = appCredentialSchema.safeParse(connection.credentials);
  if (!credentials.success) throw invalidNangoResponse();

  return {
    mode: 'managed',
    connectionId: connection.connectionId,
    integrationId: connection.integrationId,
    installationId: installationId(connection),
    installationToken: credentials.data.access_token,
    ...(credentials.data.expires_at
      ? { installationTokenExpiresAt: credentials.data.expires_at }
      : {}),
    permissions: credentials.data.raw.permissions ?? {},
    ...(credentials.data.raw.repository_selection
      ? { repositorySelection: credentials.data.raw.repository_selection }
      : {}),
    tags: connection.tags,
  };
}
