import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { connectors, projectSecrets, projectSessionSecretHandles, projectSessions } from '@kortix/db';
import { isGatewayManagedEnv } from '../llm-gateway/sandbox-credentials';
import { projectLlmGatewayEnabledById } from '../llm-gateway/enablement';
import { config } from '../config';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import {
  type SecretEgressPolicy,
  type SecretConsumer,
  type SecretStrategy,
  emitsValue,
  mintHandle,
  newLookupId,
  resolveSecretDelivery,
} from '../secrets/strategy';
import {
  buildSecretCapabilities,
  serializeSecretCapabilities,
  type SecretCapabilityCatalog,
} from './secret-capabilities';
import { decryptProjectSecret } from './secrets/envelope';
import { listProjectSecrets } from './secrets/consumer-resolution';
import { resolveGrantedSecretSelection } from './secrets/grant-policy';
export * from './secrets/envelope';
export * from './secrets/grant-policy';
export * from './secrets/consumer-resolution';

/**
 * One project secret resolved for a specific launching user: the shared
 * (project-wide) row, shadowed by that user's own ACTIVE personal override of
 * the SAME identifier if one exists (used today only by the CODEX_AUTH_JSON
 * per-user provider login — see project_secrets.ownerUserId doc comment).
 */
export interface ResolvedProjectSecret {
  /** Shared policy row id. Handles always reference this row. */
  secretId: string;
  identifier: string;
  key: string;
  value: string;
  /** Delivery strategy for this row. Absent on rows resolved before the column
   *  existed; `resolveSecretDelivery` reads absence as "no opinion", NOT as
   *  `runtime`, so an older row cannot silently downgrade a narrowed one. */
  strategy?: SecretStrategy;
  /** The only service allowed to receive plaintext. */
  consumer?: SecretConsumer | null;
  egressPolicy?: SecretEgressPolicy | null;
  handlePrefix?: string | null;
}

/**
 * Every runtime-scope project secret, resolved AS a specific user (their own
 * active override wins per identifier), grouped by IDENTIFIER — the unit an
 * agent's `secrets` grant addresses. KORTIX_* (reserved) and connector-scoped
 * rows are never included. `userId` may be null for contexts with no acting
 * human (e.g. a webhook-triggered session) — only shared rows apply then.
 */
export async function listResolvedProjectSecrets(
  projectId: string,
  userId: string | null,
): Promise<ResolvedProjectSecret[]> {
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      egressPolicy: projectSecrets.egressPolicy,
      handlePrefix: projectSecrets.handlePrefix,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.scope, 'runtime'),
        userId
          ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId))
          : isNull(projectSecrets.ownerUserId),
      ),
    );

  type Row = (typeof rows)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const out: ResolvedProjectSecret[] = [];
  for (const [identifier, slot] of byIdentifier) {
    const chosen = slot.personal && slot.personal.active ? slot.personal : slot.shared;
    if (!chosen) continue;
    const policyRow = slot.shared ?? chosen;
    out.push({
      secretId: policyRow.secretId,
      identifier,
      key: chosen.name,
      value: decryptProjectSecret(projectId, chosen.valueEnc),
      strategy: policyRow.strategy ?? undefined,
      consumer: policyRow.consumer ?? undefined,
      egressPolicy: policyRow.egressPolicy ?? null,
      handlePrefix: policyRow.handlePrefix ?? null,
    });
  }
  return out;
}

export function projectSecretsRevision(env: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function listProjectSecretsSnapshot(projectId: string): Promise<{
  env: Record<string, string>;
  names: string[];
  revision: string;
}> {
  const env = await listProjectSecrets(projectId);
  const names = Object.keys(env).sort();
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
  };
}

/**
 * Per-user, per-agent-grant snapshot — the sandbox-boot view. `grantEnv` is the
 * running agent's `secrets` grant (`AgentGrant.env`); omitted/`'all'` = every
 * secret in the project reaches this session (see resolveGrantedSecretEnv).
 */
/**
 * THE chokepoint: everything a sandbox is handed passes through here.
 *
 * Two production callers — sandbox boot (`buildSessionSandboxEnvVars`) and the
 * per-prompt hot push (`resolveOwnerRawEnv`) — which is why the delivery
 * decision belongs here rather than at either of them. A row's `strategy`
 * decides whether its value may enter the box AT ALL; the pre-existing grant and
 * allowlist narrowing decide only WHICH rows are considered.
 *
 * `sessionId` is required to deliver anything non-`runtime`: a brokered value is
 * represented in the box by a per-session handle, and with no session there is
 * nothing to mint against. Absent it, non-`runtime` rows are withheld rather
 * than falling back to plaintext — the fallback would defeat the whole point.
 */
/**
 * Delete from `env` every KEY that no longer has a deliverable value.
 *
 * Mutates in place because the caller owns the map and this is a pure narrowing
 * of it — a row whose delivery says "nothing" is removed from the values, and
 * therefore from `names`, which the daemon derives from the same map. (A name
 * emitted without a value, or the reverse, desynchronises the box's env store.)
 *
 * The subtlety is the SHARED KEY. Two identifiers may resolve to one env KEY —
 * that is deliberate, so an agent can be granted one specific value among
 * several candidates for the same variable. A KEY may therefore only be dropped
 * when EVERY identifier behind it is undeliverable; if one is still `runtime`,
 * the KEY has a legitimate value and dropping it would break a working session.
 */
export function withholdUndeliverable(
  rows: ResolvedProjectSecret[],
  env: Record<string, string>,
  sessionId: string | null,
): void {
  const deliverableKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const row of rows) {
    seenKeys.add(row.key);
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      sessionId,
      // The agent grant and the session allowlist were BOTH applied upstream by
      // resolveGrantedSecretEnv; re-applying them here would double-count and
      // could withhold a row the caller already admitted.
      agentGrantEnv: 'all',
      sessionAllowlist: null,
    });
    if (emitsValue(delivery)) deliverableKeys.add(row.key);
  }
  for (const key of seenKeys) {
    if (!deliverableKeys.has(key)) delete env[key];
  }
}

export type SecretHandleMinter = (row: ResolvedProjectSecret) => Promise<string>;

/**
 * Replace selected plaintext values with delivery-safe material.
 *
 * `rows` contains one deterministic winner per env key. The function mutates
 * the caller-owned map. It never adds a key that the grant resolver excluded.
 */
/**
 * Does the LLM-gateway strip apply to this row?
 *
 * The strip exists so a PLATFORM-managed model credential never reaches
 * opencode while the gateway owns that provider. It used to key off the NAME
 * alone, via `isGatewayManagedEnv`, which answers from the models.dev catalog —
 * a 204-provider registry that maps `github-copilot` to `GITHUB_TOKEN`. So a
 * project's own `GITHUB_TOKEN`, stored by the secrets UI as
 * `consumer: 'sandbox'`, was deleted from every sandbox env by name collision
 * with a provider nobody in the project had connected. Verified in prod
 * 2026-08-27: the capability catalog advertised it, no process in the box had
 * it, and the daemon logged `withheld: 0` because it was dropped server-side.
 *
 * The row already carries the answer. The platform stamps `consumer` when it
 * stores a model credential (`routes/provider-oauth.ts` defaultToGateway, the
 * provider-connect UI) and `sandbox` when a human adds an ordinary secret. Trust
 * that stamp:
 *
 *   - `llm_gateway` (or any non-sandbox consumer) → stripped, as before.
 *   - `null`/`undefined` → stripped. A row written before the column existed
 *     carries no intent to trust, so legacy behavior is preserved exactly.
 *   - `sandbox` → delivered. The user asked for this variable in their own box.
 *
 * What this deliberately does NOT weaken: managed credentials and anything the
 * provider-connect flow stored keep their stamp and stay withheld, and
 * `CODEX_AUTH_JSON`/`OPENCODE_AUTH_JSON` are unconditionally gateway-managed.
 *
 * Pure so the rule is testable without a model catalog.
 */
export function gatewayStripsRow(input: {
  llmGatewayEnabled: boolean;
  nameIsGatewayManaged: boolean;
  consumer: SecretConsumer | null | undefined;
}): boolean {
  return input.llmGatewayEnabled && input.nameIsGatewayManaged && input.consumer !== 'sandbox';
}

export async function materializeSecretDelivery(
  rows: ResolvedProjectSecret[],
  env: Record<string, string>,
  input: {
    sessionId: string | null;
    grantEnv: string[] | 'all' | undefined;
    mintHandleFor: SecretHandleMinter;
    /**
     * The project's effective `llm_gateway` mode — the fork between the two
     * model-credential delivery paths:
     *
     *  • gateway ON  — provider API keys are SERVICE credentials. Every
     *    gateway-managed name is withheld from the box; the gateway resolves
     *    the value server-side after authenticating the session token.
     *  • gateway OFF (native OpenCode) — the same stored rows ARE the box's
     *    credentials. A `consumer: 'llm_gateway'` row delivers its plaintext
     *    value so OpenCode's native provider management auto-connects, and a
     *    provider-key NAME is an ordinary env var.
     */
    llmGatewayEnabled: boolean;
  },
): Promise<ResolvedProjectSecret[]> {
  const delivered: ResolvedProjectSecret[] = [];
  for (const row of rows) {
    if (!(row.key in env)) continue;
    // A gateway-managed NAME is not the same thing as a gateway-managed ROW.
    // `isGatewayManagedEnv` asks the models.dev catalog, which today maps the
    // `github-copilot` provider to `GITHUB_TOKEN` — so a project's own
    // `GITHUB_TOKEN` (stored `consumer: 'sandbox'`, the shape the secrets UI
    // creates) was silently deleted from every sandbox env while the capability
    // catalog kept advertising it. The platform stamps `consumer` when it
    // stores a model credential (`routes/provider-oauth.ts` defaultToGateway); trust that
    // stamp, not a third-party name table. `consumer == null` is a legacy row
    // with no stamp to trust, so it keeps today's strip.
    if (
      gatewayStripsRow({
        llmGatewayEnabled: input.llmGatewayEnabled,
        nameIsGatewayManaged: isGatewayManagedEnv(row.key),
        consumer: row.consumer,
      })
    ) {
      delete env[row.key];
      continue;
    }
    if (!input.llmGatewayEnabled && row.consumer === 'llm_gateway') {
      // Native mode: the row was stored `broker`/`llm_gateway` only because the
      // platform defaulted provider keys there (routes/provider-oauth.ts `defaultToGateway`,
      // the provider-connect UI). With no gateway in the path it delivers like a
      // `runtime` row — plaintext, so toggling the flag never strands the key.
      delivered.push(row);
      continue;
    }
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      sessionId: input.sessionId,
      agentGrantEnv: input.grantEnv ?? null,
      sessionAllowlist: null,
    });
    const consumer =
      row.consumer ??
      (delivery.strategy === 'runtime'
        ? 'sandbox'
        : row.egressPolicy?.backend === 'kortix_fetch'
          ? 'http_broker'
          : (row.egressPolicy?.backend ?? null));
    if (delivery.emit === 'plaintext' && consumer === 'sandbox') {
      delivered.push(row);
      continue;
    }
    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'broker' &&
      consumer === 'http_broker' &&
      row.egressPolicy?.backend === 'kortix_fetch'
    ) {
      env[row.key] = await input.mintHandleFor(row);
      delivered.push(row);
      continue;
    }
    // Egress-enforced: the KEY holds the HANDLE, never the value.
    //
    // This used to mint the handle row and export nothing, on the theory that
    // an empty env is the strongest possible boundary. It is also a boundary
    // the agent cannot use: an ordinary HTTP client has nothing to send, so
    // every SDK that reads `os.environ[...]` fails with an unset variable and
    // the model's only way forward is to ask a human for the real value.
    //
    // The handle is what makes the mechanism transparent: the client sends it, the
    // relay swaps it for the value server-side on an approved host, and a
    // handle that leaks anywhere else is a self-describing string worth
    // nothing. Same per-session rotation and same revocation as a broker
    // handle — it is the same minting path.
    //
    // A row with no policy is dropped rather than minted: there is nothing to
    // freeze into the handle's snapshot, so the mint would throw and take the
    // whole env snapshot — and with it the session boot — down with it. The
    // broker branch above already fails closed the same way.
    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'egress' &&
      consumer === 'network' &&
      row.egressPolicy
    ) {
      env[row.key] = await input.mintHandleFor(row);
      delivered.push(row);
      continue;
    }
    delete env[row.key];
  }
  return delivered;
}

async function mintSessionSecretHandle(
  projectId: string,
  sessionId: string,
  row: ResolvedProjectSecret,
): Promise<string> {
  const egressPolicy = row.egressPolicy;
  if (!egressPolicy) throw new Error('Managed secret delivery requires a policy');

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${sessionId}:${row.secretId}`}, 0))`,
    );
    const [session] = await tx
      .select({ accountId: projectSessions.accountId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!session) throw new Error('Cannot mint a secret handle without its project session');

    const [latest] = await tx
      .select()
      .from(projectSessionSecretHandles)
      .where(
        and(
          eq(projectSessionSecretHandles.sessionId, sessionId),
          eq(projectSessionSecretHandles.secretId, row.secretId),
        ),
      )
      .orderBy(desc(projectSessionSecretHandles.revision))
      .limit(1);

    const policyMatches =
      latest && JSON.stringify(latest.policySnapshot) === JSON.stringify(egressPolicy);
    const notExpired = !latest?.expiresAt || latest.expiresAt.getTime() > Date.now();
    if (latest?.status === 'active' && policyMatches && notExpired) {
      const handle = sessionSecretHandle(latest.lookupId, row);
      const hash = createHash('sha256').update(handle).digest('hex');
      if (hash !== latest.handleHash) {
        await tx
          .update(projectSessionSecretHandles)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
        throw new Error('Stored secret handle integrity check failed');
      }
      return {
        handle,
        issued: false,
        accountId: session.accountId,
        revision: latest.revision,
      };
    }

    if (latest?.status === 'active') {
      await tx
        .update(projectSessionSecretHandles)
        .set({ status: 'superseded' })
        .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
    }
    const revision = (latest?.revision ?? 0) + 1;
    const lookupId = newLookupId(randomBytes(20));
    const handle = sessionSecretHandle(lookupId, row);
    await tx.insert(projectSessionSecretHandles).values({
      projectId,
      sessionId,
      secretId: row.secretId,
      identifier: row.identifier,
      envName: row.key,
      lookupId,
      handleHash: createHash('sha256').update(handle).digest('hex'),
      revision,
      policySnapshot: egressPolicy,
      status: 'active',
    });
    return { handle, issued: true, accountId: session.accountId, revision };
  });

  if (result.issued) {
    await auditSessionSecretHandle(projectId, sessionId, row, result.accountId, result.revision);
  }
  return result.handle;
}

function sessionSecretHandle(lookupId: string, row: ResolvedProjectSecret): string {
  return mintHandle({ lookupId, prefix: row.handlePrefix, rootSecret: config.API_KEY_SECRET });
}

async function auditSessionSecretHandle(
  projectId: string,
  sessionId: string,
  row: ResolvedProjectSecret,
  accountId: string,
  revision: number,
): Promise<void> {
  await recordAuditEvent({
    accountId,
    projectId,
    sessionId,
    actorType: 'system',
    source: 'system',
    action: 'secret.handle.issued',
    resourceType: 'project_secret',
    resourceId: row.secretId,
    metadata: {
      identifier: row.identifier,
      consumer: row.consumer ?? (row.strategy === 'egress' ? 'network' : 'http_broker'),
      strategy: row.strategy ?? 'broker',
      revision,
    },
  });
}

export async function listProjectSecretsSnapshotForUser(
  projectId: string,
  userId: string | null,
  grantEnv?: string[] | 'all',
  sessionId?: string | null,
): Promise<{
  env: Record<string, string>;
  names: string[];
  revision: string;
  capabilities: SecretCapabilityCatalog;
  capabilitiesJson: string;
}> {
  // Three reads of three different tables, none of them keyed on another's
  // result: sent together, awaited where they are first used. Sequentially this
  // was three round trips inside the per-prompt env sync.
  // Promise.resolve, not the query builder itself: a Drizzle builder is a
  // thenable, so it starts here but has no `.catch` to keep an early return
  // from surfacing an unhandled rejection.
  const connectorRead = Promise.resolve(
    db.select({ identifier: connectors.authSecret }).from(connectors).where(eq(connectors.projectId, projectId)),
  );
  const gatewayRead = projectLlmGatewayEnabledById(projectId);
  connectorRead.catch(() => undefined);
  gatewayRead.catch(() => undefined);
  const rows = await listResolvedProjectSecrets(projectId, userId);
  const boundConnectorIdentifiers = new Set(
    (await connectorRead)
      .map((row) => row.identifier)
      .filter((identifier): identifier is string => Boolean(identifier)),
  );
  const sandboxRows = rows.filter((row) => !boundConnectorIdentifiers.has(row.identifier));
  const { env, selected } = resolveGrantedSecretSelection(sandboxRows, grantEnv);
  // Resolved HERE, once, so boot, hot push, and the toggle fan-out all deliver
  // model credentials from the same decision — a caller cannot pass a stale
  // mode and desynchronise the box from the project's flag.
  const llmGatewayEnabled = await gatewayRead;
  const delivered = await materializeSecretDelivery(selected, env, {
    sessionId: sessionId ?? null,
    grantEnv,
    llmGatewayEnabled,
    mintHandleFor: async (row) => {
      if (!sessionId) throw new Error('Secret handle delivery requires a session');
      return mintSessionSecretHandle(projectId, sessionId, row);
    },
  });

  const names = Object.keys(env).sort();
  // From `delivered`, never `selected`: a row whose value materialization
  // dropped must not be advertised. `secretNamesForSandbox` states the
  // invariant — a name appears IFF a value is emitted for it — and building
  // capabilities from the pre-delivery set is exactly how the box came to be
  // told it held a `GITHUB_TOKEN` that was never in its env.
  const capabilities = buildSecretCapabilities(delivered, {
    grantEnv,
    sessionId: sessionId ?? null,
  });
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
    capabilities,
    capabilitiesJson: serializeSecretCapabilities(capabilities),
  };
}

export async function getProjectSecretValue(
  projectId: string,
  name: string,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      valueEnc: projectSecrets.valueEnc,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, normalizedName),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  if (rows.length === 0) return null;
  // Deterministic pick when multiple identifiers share this key: the canonical
  // (identifier === key) row wins, else the most-recently-updated one.
  const canonical = rows.find((r) => r.identifier === normalizedName);
  const row =
    canonical ?? [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
  return decryptProjectSecret(projectId, row.valueEnc);
}
