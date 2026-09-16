/**
 * Gate prompts on explicit session and running-agent connector requirements.
 * A binding selects a connection; it does not make that connector mandatory.
 * Optional connection failures belong to the connector call, not every prompt.
 * Lookup failures remain retryable 503s, distinct from confirmed 409 refusals.
 */

import { projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { loadProjectAgents, requiredConnectorsForAgent } from '../agents';
import { effectiveRunningAgent } from './secret-grant';
import type { RequiredConnectorConnection } from '@kortix/api-contract';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import {
  piWorkerRuntimeIdentityFromSessionMetadata,
  sessionMetadataClaimsPiWorker,
} from './session-sandbox-metadata';
import {
  RequiredConnectorConnectionUnavailableError,
  missingRequiredConnectorConnectionsForSession,
} from './session-connector-bindings';

/**
 * We could not determine whether this session's connectors are usable.
 *
 * Deliberately distinct from "they are not usable". The proxy turns this into a
 * 503, which the client retries; turning it into the 409 would render a
 * permanent, false "connect Gmail" prompt off a transient git read.
 */
export class PromptConnectorPreflightUnresolved extends Error {
  constructor(cause: unknown) {
    super(
      `Could not verify this session's required connectors: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PromptConnectorPreflightUnresolved';
    this.cause = cause;
  }
}

export type PromptConnectorVerdict =
  | { ok: true }
  /** The alias is a connector on the project, but nothing usable is connected to it. */
  | {
      ok: false;
      kind: 'authorization_required';
      connections: RequiredConnectorConnection[];
    }
  /** The alias is not a connector on this project at all — only a manifest change fixes it. */
  | { ok: false; kind: 'unavailable'; aliases: string[] };

/**
 * Every alias this prompt requires, deduped and canonicalised.
 *
 * Exported for its own test: the union is the part most likely to silently lose
 * a source, and a gate that checks the empty set passes everything.
 */
export function unionRequiredAliases(input: {
  sessionRequired: readonly string[] | null | undefined;
  manifestRequired: readonly string[];
}): string[] {
  const seen = new Set<string>();
  for (const raw of [...(input.sessionRequired ?? []), ...input.manifestRequired]) {
    const alias = canonicalConnectorAlias(String(raw ?? '').trim());
    if (alias) seen.add(alias);
  }
  return [...seen];
}

export async function missingPromptConnectorConnections(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  sessionAgent: string;
  requestedAgent: string | null;
}): Promise<PromptConnectorVerdict> {
  let aliases: string[];
  try {
    const [[session], [project]] = await Promise.all([
      db
        .select({
          requiredConnectors: projectSessions.requiredConnectors,
          metadata: projectSessions.metadata,
          agentName: projectSessions.agentName,
        })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, input.sessionId),
            eq(projectSessions.projectId, input.projectId),
            eq(projectSessions.accountId, input.accountId),
          ),
        )
        .limit(1),
      db
        .select({
          repoUrl: projects.repoUrl,
          defaultBranch: projects.defaultBranch,
          manifestPath: projects.manifestPath,
        })
        .from(projects)
        .where(and(eq(projects.projectId, input.projectId), eq(projects.accountId, input.accountId)))
        .limit(1),
    ]);

    const piIdentity = piWorkerRuntimeIdentityFromSessionMetadata(session?.metadata);
    if (sessionMetadataClaimsPiWorker(session?.metadata) && !piIdentity) {
      throw new Error('Pi session runtime identity is incomplete');
    }
    if (piIdentity && !project) throw new Error('Pi session project is unavailable');
    const sourceRef = piIdentity?.sha ?? project?.defaultBranch;
    let manifestRequired: string[] = [];
    if (project && sourceRef) {
      // NOT forceRefresh. The warm-claim path uses it because it runs once per
      // session; this runs once per prompt, and the mirror's own TTL is the
      // right freshness for a per-turn read.
      //
      // `rethrowReadErrors` is load-bearing: by default loadProjectAgents
      // swallows an unreadable manifest into a synthesized one, which here would
      // mean "this agent requires nothing" — the gate silently never firing,
      // which is the failure it exists to prevent.
      const loaded = await loadProjectAgents(
        {
          projectId: input.projectId,
          repoUrl: project.repoUrl,
          defaultBranch: sourceRef,
          manifestPath: project.manifestPath ?? 'kortix.yaml',
          gitAuthToken: null,
        },
        { rethrowReadErrors: true },
      );
      manifestRequired = requiredConnectorsForAgent(
        piIdentity
          ? (session?.agentName ?? input.sessionAgent)
          : effectiveRunningAgent(input.requestedAgent, input.sessionAgent),
        loaded,
      );
    }

    aliases = unionRequiredAliases({
      sessionRequired: session?.requiredConnectors,
      manifestRequired,
    });
  } catch (err) {
    throw new PromptConnectorPreflightUnresolved(err);
  }

  // The overwhelmingly common case, and it costs nothing beyond the reads above:
  // no alias is required, so there is nothing to resolve per-alias.
  if (aliases.length === 0) return { ok: true };

  try {
    const missing = await missingRequiredConnectorConnectionsForSession({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      aliases,
    });
    return missing.length === 0
      ? { ok: true }
      : { ok: false, kind: 'authorization_required', connections: missing };
  } catch (err) {
    // The one throw from that helper that IS a verdict rather than a failure.
    if (err instanceof RequiredConnectorConnectionUnavailableError) {
      return { ok: false, kind: 'unavailable', aliases: err.aliases };
    }
    throw new PromptConnectorPreflightUnresolved(err);
  }
}
