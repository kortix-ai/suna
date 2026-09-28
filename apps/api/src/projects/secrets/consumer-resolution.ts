import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import type { SecretConsumer, SecretStrategy } from '../../secrets/strategy';
import { decryptProjectSecret, encryptProjectSecret } from './envelope';

/**
 * Upsert the SHARED (owner_user_id IS NULL) row for a project secret to a new
 * value, keyed by IDENTIFIER (defaults to the KEY when omitted — the migrated/
 * simple case). Mirrors the POST /secrets handler's insert/onConflict, factored
 * out so the public setup-link intake endpoint (no authenticated user) can write
 * the value a human supplied via a minted link. `scope` is only set on first
 * insert — an existing connector-scoped row keeps its scope on re-submit.
 */
export async function writeSharedProjectSecret(input: {
  projectId: string;
  name: string;
  identifier?: string;
  value: string;
  scope?: 'runtime' | 'connector';
  createdBy?: string | null;
}): Promise<void> {
  const now = new Date();
  const identifier = input.identifier ?? input.name;
  const serverSide = input.scope === 'connector';
  await db
    .insert(projectSecrets)
    .values({
      projectId: input.projectId,
      identifier,
      name: input.name,
      valueEnc: encryptProjectSecret(input.projectId, input.value),
      scope: serverSide ? 'connector' : 'runtime',
      strategy: serverSide ? 'broker' : 'runtime',
      consumer: serverSide ? 'connector' : 'sandbox',
      strategyLocked: serverSide,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.identifier],
      targetWhere: isNull(projectSecrets.ownerUserId),
      set: {
        name: input.name,
        valueEnc: encryptProjectSecret(input.projectId, input.value),
        ...(serverSide
          ? {
              scope: 'connector' as const,
              strategy: 'broker' as const,
              consumer: 'connector' as const,
              strategyLocked: true,
            }
          : {}),
        updatedAt: now,
      },
    });
}

/** Lock a legacy runtime secret to the server-side connector boundary. */
export async function confineSharedProjectSecretToConnector(
  projectId: string,
  identifier: string,
): Promise<void> {
  await db
    .update(projectSecrets)
    .set({
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      strategyLocked: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.identifier, identifier),
        isNull(projectSecrets.ownerUserId),
      ),
    );
}

/**
 * Decrypted KEY->value map of the project's SHARED runtime secrets
 * (owner_user_id IS NULL). Platform-reserved KORTIX_* rows are excluded so
 * legacy system secrets can never leak into the sandbox as user-controlled env
 * vars. Since a KEY is no longer unique (multiple identifiers may share one),
 * ties are broken deterministically: the row whose identifier equals the key
 * wins (the common/migrated case), else the most-recently-updated row. This is
 * the general project-scoped view used by non-sandbox callers (e.g. Slack
 * install lookup, the LLM-gateway provider picker); sandbox boot uses
 * `listProjectSecretsSnapshotForUser` so the running agent's `secrets` grant
 * (by identifier) is honored.
 */
export async function listProjectSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), isNull(projectSecrets.ownerUserId)))
    .orderBy(desc(projectSecrets.updatedAt));

  const env: Record<string, string> = {};
  const winnerIsCanonical = new Set<string>();
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    // Connector credentials / Pipedream bindings are resolved server-side by the
    // Connector gateway — never injected into the sandbox env.
    if (row.scope === 'connector') continue;
    const canonical = row.identifier === row.name;
    if (row.name in env && winnerIsCanonical.has(row.name) && !canonical) continue;
    env[row.name] = decryptProjectSecret(projectId, row.valueEnc);
    if (canonical) winnerIsCanonical.add(row.name);
  }
  return env;
}

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

type ConsumerAuditAction = 'missing' | 'denied' | 'invalid' | 'used';

async function recordSecretConsumerAudit(
  input: ProjectSecretConsumerRead,
  accountId: string,
  action: ConsumerAuditAction,
  metadata: Record<string, unknown>,
  resourceId?: string,
): Promise<void> {
  await recordAuditEvent({
    accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
    source: input.consumer,
    ...(action === 'used' ? {} : { outcome: action === 'invalid' ? 'failure' as const : 'denied' as const }),
    action: `secret.consumer.${action}`,
    resourceType: 'project_secret',
    ...(resourceId ? { resourceId } : {}),
    metadata,
  });
}

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

type ConsumerRow = {
  secretId: string;
  identifier: string;
  ownerUserId: string | null;
  valueEnc: string;
  scope: string;
  active: boolean;
  strategy: SecretStrategy;
  consumer: SecretConsumer | null;
  updatedAt: Date;
};

function selectConsumerRows(rows: ConsumerRow[], principalUserId: string | null | undefined, name: string) {
  const byIdentifier = new Map<string, { shared?: ConsumerRow; personal?: ConsumerRow }>();
  for (const row of rows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.ownerUserId === principalUserId) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }
  return [...byIdentifier.entries()]
    .map(([identifier, slot]) => ({
      identifier,
      row: slot.personal?.active ? slot.personal : (slot.shared ?? slot.personal),
      policyRow: slot.shared ?? slot.personal,
    }))
    .filter(
      (entry): entry is { identifier: string; row: ConsumerRow; policyRow: ConsumerRow } =>
        Boolean(entry.row && entry.policyRow),
    )
    .sort((a, b) => {
      if (a.identifier === name) return -1;
      if (b.identifier === name) return 1;
      const updatedDifference = b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
      return updatedDifference || a.identifier.localeCompare(b.identifier);
    });
}

async function processConsumerCandidate(
  input: ProjectSecretConsumerRead,
  accountId: string,
  name: string,
  row: ConsumerRow,
  policyRow: ConsumerRow,
): Promise<ProjectSecretConsumerValue | null> {
  const valueSource = row.ownerUserId ? 'personal' : 'shared';
  if (!row.active || !secretPolicyAllowsConsumer(policyRow, input.consumer)) {
    await recordSecretConsumerAudit(input, accountId, 'denied', {
      identifier: row.identifier,
      name,
      requested_consumer: input.consumer,
      configured_consumer: policyRow.consumer,
      strategy: policyRow.strategy,
      value_source: valueSource,
    }, row.secretId);
    return null;
  }
  let value: string;
  try {
    value = decryptProjectSecret(input.projectId, row.valueEnc);
  } catch {
    await recordSecretConsumerAudit(input, accountId, 'invalid', {
      identifier: row.identifier,
      name,
      consumer: input.consumer,
      value_source: valueSource,
    }, row.secretId);
    return null;
  }
  await recordSecretConsumerAudit(input, accountId, 'used', {
    identifier: row.identifier,
    name,
    consumer: input.consumer,
    value_source: valueSource,
  }, row.secretId);
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
  const accountId =
    input.accountId ??
    (
      await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, input.projectId))
        .limit(1)
    )[0]?.accountId;
  if (!accountId) return [];
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
  if (rows.length === 0) {
    await recordSecretConsumerAudit(input, accountId, 'missing', {
      name: normalizedName,
      consumer: input.consumer,
    });
    return [];
  }

  const resolved: ProjectSecretConsumerValue[] = [];
  for (const { row, policyRow } of selectConsumerRows(rows, input.principalUserId, normalizedName)) {
    const value = await processConsumerCandidate(input, accountId, normalizedName, row, policyRow);
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
