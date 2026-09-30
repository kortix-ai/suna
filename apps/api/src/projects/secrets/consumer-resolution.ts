import { projectSecrets, projects } from '@kortix/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { SecretConsumer, SecretStrategy } from '../../secrets/strategy';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { filterSecretRowsByAudience, secretAudiencePerson } from '../lib/secret-audience';
import { decryptProjectSecret } from './envelope';
import { secretAudienceRank } from './grant-policy';

export interface ProjectSecretConsumerRead {
  projectId: string;
  accountId?: string;
  sessionId?: string | null;
  actorUserId?: string | null;
  /** Select this user's active personal override before the shared value. */
  principalUserId?: string | null;
  name: string;
  consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
}

export interface ProjectSecretConsumerValue {
  accountId: string;
  secretId: string;
  identifier: string;
  ownerUserId: string | null;
  updatedAt: Date;
  value: string;
}

type ServerSecretConsumer = Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;

export type ProjectSecretConsumerConfigurationStatus =
  | 'configured'
  | 'missing'
  | 'inactive'
  | 'delivery_mismatch';

function secretPolicyAllowsConsumer(
  row: {
    scope: string;
    strategy: SecretStrategy;
    consumer: SecretConsumer | null;
  },
  consumer: ServerSecretConsumer,
): boolean {
  return consumer === 'connector'
    ? (row.strategy === 'broker' && row.consumer === 'connector') ||
        (row.scope === 'connector' &&
          (row.consumer === 'connector' || row.consumer === 'sandbox'))
    : row.strategy === 'broker' && row.consumer === consumer;
}

/**
 * Read whether a named shared secret can cross one server-consumer boundary.
 * This does not decrypt the value. Callers can distinguish a missing secret
 * from an existing secret whose delivery policy denies the consumer.
 */
export async function getProjectSecretConsumerConfigurationStatus(input: {
  projectId: string;
  name: string;
  consumer: ServerSecretConsumer;
}): Promise<ProjectSecretConsumerConfigurationStatus> {
  const normalizedName = input.name.trim().toUpperCase();
  const rows = await db
    .select({
      scope: projectSecrets.scope,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.name, normalizedName),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  if (rows.length === 0) return 'missing';
  if (rows.some((row) => row.active && secretPolicyAllowsConsumer(row, input.consumer))) {
    return 'configured';
  }
  if (rows.some((row) => row.active)) return 'delivery_mismatch';
  return 'inactive';
}

export async function projectSecretIsConfiguredForConsumer(input: {
  projectId: string;
  name: string;
  consumer: ServerSecretConsumer;
}): Promise<boolean> {
  return (await getProjectSecretConsumerConfigurationStatus(input)) === 'configured';
}

export async function listProjectSecretNamesForConsumer(input: {
  projectId: string;
  principalUserId?: string | null;
  consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
}): Promise<string[]> {
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      scope: projectSecrets.scope,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        input.principalUserId
          ? or(
              isNull(projectSecrets.ownerUserId),
              eq(projectSecrets.ownerUserId, input.principalUserId),
            )
          : isNull(projectSecrets.ownerUserId),
      ),
    );

  type Row = (typeof rows)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.ownerUserId === input.principalUserId) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const names = new Set<string>();
  for (const slot of byIdentifier.values()) {
    const selected = slot.personal?.active ? slot.personal : slot.shared;
    if (!selected?.active || selected.name.toUpperCase().startsWith('KORTIX_')) continue;
    const policy = slot.shared ?? selected;
    const configured = secretPolicyAllowsConsumer(policy, input.consumer);
    if (configured) names.add(selected.name.toUpperCase());
  }
  return [...names].sort();
}

/**
 * One consumer decision, audited. Every consumer-decision audit event carries
 * the read's account/project/session/actor context, the requesting consumer as
 * source and `project_secret` as the resource type; the sites differ only in
 * action, outcome, resource id and metadata.
 */
async function recordSecretConsumerAudit(
  input: ProjectSecretConsumerRead,
  accountId: string,
  event: {
    action:
      | 'secret.consumer.missing'
      | 'secret.consumer.denied'
      | 'secret.consumer.invalid'
      | 'secret.consumer.used';
    outcome?: 'denied' | 'failure';
    resourceId?: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await recordAuditEvent({
    accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
    source: input.consumer,
    ...event,
    resourceType: 'project_secret',
  });
}

/**
 * The acting account and every shared-or-personal candidate row for one
 * consumer read, grouped by identifier and placed in deterministic fallback
 * order. Null when the project has no account.
 */
async function loadProjectSecretConsumerRows(input: ProjectSecretConsumerRead) {
  const accountId =
    input.accountId ??
    (
      await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, input.projectId))
        .limit(1)
    )[0]?.accountId;
  if (!accountId) return null;
  const normalizedName = input.name.trim().toUpperCase();
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      ownerUserId: projectSecrets.ownerUserId,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      active: projectSecrets.active,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.name, normalizedName),
        input.principalUserId
          ? or(
              isNull(projectSecrets.ownerUserId),
              eq(projectSecrets.ownerUserId, input.principalUserId),
            )
          : isNull(projectSecrets.ownerUserId),
      ),
    );

  // A narrowed shared value is a candidate only for a person in its audience:
  // the on-behalf-of human of a private session, else the direct caller.
  // Callers with no session and no actor (git proxy, webhooks, channel
  // installs, catalog sync) get values shared with everyone only.
  const reachable = await filterSecretRowsByAudience({
    projectId: input.projectId,
    accountId,
    personId: () =>
      secretAudiencePerson({
        projectId: input.projectId,
        accountId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
      }),
    rows,
  });
  type Row = (typeof reachable)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of reachable) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.ownerUserId === input.principalUserId) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const selectedRows = [...byIdentifier.entries()]
    .map(([identifier, slot]) => ({
      identifier,
      row: slot.personal?.active ? slot.personal : (slot.shared ?? slot.personal),
      policyRow: slot.shared ?? slot.personal,
    }))
    .filter(
      (entry): entry is { identifier: string; row: Row; policyRow: Row } =>
        Boolean(entry.row && entry.policyRow),
    )
    .sort((a, b) => {
      const rank = secretAudienceRank(a.policyRow.audience) - secretAudienceRank(b.policyRow.audience);
      if (rank !== 0) return rank;
      if (a.identifier === normalizedName) return -1;
      if (b.identifier === normalizedName) return 1;
      const updatedDifference = b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
      return updatedDifference || a.identifier.localeCompare(b.identifier);
    });
  return { accountId, normalizedName, selectedRows };
}

type ConsumerCandidateRow = NonNullable<
  Awaited<ReturnType<typeof loadProjectSecretConsumerRows>>
>['selectedRows'][number]['row'];

/**
 * Policy-check, decrypt and audit one candidate row. Returns the resolved
 * value, or null when the policy denies the consumer or the ciphertext fails.
 */
async function resolveOneConsumerSecretRow(
  input: ProjectSecretConsumerRead,
  accountId: string,
  normalizedName: string,
  row: ConsumerCandidateRow,
  policyRow: ConsumerCandidateRow,
): Promise<ProjectSecretConsumerValue | null> {
  const allowed = row.active && secretPolicyAllowsConsumer(policyRow, input.consumer);
  if (!allowed) {
    await recordSecretConsumerAudit(input, accountId, {
      outcome: 'denied',
      action: 'secret.consumer.denied',
      resourceId: row.secretId,
      metadata: {
        identifier: row.identifier,
        name: normalizedName,
        requested_consumer: input.consumer,
        configured_consumer: policyRow.consumer,
        strategy: policyRow.strategy,
        value_source: row.ownerUserId ? 'personal' : 'shared',
      },
    });
    return null;
  }

  let value: string;
  try {
    value = decryptProjectSecret(input.projectId, row.valueEnc);
  } catch {
    await recordSecretConsumerAudit(input, accountId, {
      outcome: 'failure',
      action: 'secret.consumer.invalid',
      resourceId: row.secretId,
      metadata: {
        identifier: row.identifier,
        name: normalizedName,
        consumer: input.consumer,
        value_source: row.ownerUserId ? 'personal' : 'shared',
      },
    });
    return null;
  }
  await recordSecretConsumerAudit(input, accountId, {
    action: 'secret.consumer.used',
    resourceId: row.secretId,
    metadata: {
      identifier: row.identifier,
      name: normalizedName,
      consumer: input.consumer,
      value_source: row.ownerUserId ? 'personal' : 'shared',
    },
  });
  return {
    accountId,
    secretId: row.secretId,
    identifier: row.identifier,
    ownerUserId: row.ownerUserId,
    updatedAt: row.updatedAt,
    value,
  };
}

/** Resolve up to maxValues in deterministic fallback order. */
async function resolveProjectSecretValuesForConsumer(
  input: ProjectSecretConsumerRead,
  maxValues: number,
): Promise<ProjectSecretConsumerValue[]> {
  const loaded = await loadProjectSecretConsumerRows(input);
  if (!loaded) return [];
  const { accountId, normalizedName, selectedRows } = loaded;
  if (selectedRows.length === 0) {
    await recordSecretConsumerAudit(input, accountId, {
      outcome: 'denied',
      action: 'secret.consumer.missing',
      metadata: { name: normalizedName, consumer: input.consumer },
    });
    return [];
  }

  const resolved: ProjectSecretConsumerValue[] = [];
  for (const { row, policyRow } of selectedRows) {
    const value = await resolveOneConsumerSecretRow(
      input,
      accountId,
      normalizedName,
      row,
      policyRow,
    );
    if (!value) continue;
    resolved.push(value);
    if (resolved.length >= maxValues) break;
  }
  return resolved;
}

/** Resolve every authorized value for one key through its server consumer. */
export async function resolveProjectSecretsForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<ProjectSecretConsumerValue[]> {
  return resolveProjectSecretValuesForConsumer(input, Number.POSITIVE_INFINITY);
}

/** Resolve the first authorized value in deterministic fallback order. */
export async function resolveProjectSecretForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<ProjectSecretConsumerValue | null> {
  return (await resolveProjectSecretValuesForConsumer(input, 1))[0] ?? null;
}

export async function getProjectSecretValueForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<string | null> {
  return (await resolveProjectSecretForConsumer(input))?.value ?? null;
}
