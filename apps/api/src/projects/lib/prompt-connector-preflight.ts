/**
 * Refusing a PROMPT whose connectors cannot serve it — before the sandbox sees it.
 *
 * The pre-flight that already exists runs at session CREATE and at warm-claim
 * (projects/lib/sessions.ts, routes/r7.ts). A mid-session prompt passed through
 * ungated, so the founder's session answered "Still no active connectors. The
 * Gmail connector is gone from the executor catalog." — the agent improvising an
 * apology, mid-turn, about something the platform knew before the first byte.
 *
 * That is the whole failure the pre-flight exists to prevent, and it was only
 * ever prevented at create. Nothing about the reason is create-specific: a
 * connection can be revoked, a profile deactivated, or a scope re-pointed at any
 * moment, and every one of those lands on the next prompt.
 *
 * WHAT COUNTS AS REQUIRED — the union of three sources, because no one of them
 * is complete:
 *
 *   1. The session's own `requiredConnectors`. What the caller declared for THIS
 *      session, including an alias with no connection yet — the only source that
 *      can express "this session needs Gmail" before a Gmail account exists to
 *      point at. A binding row cannot: `profile_id` is NOT NULL.
 *   2. The RUNNING agent's manifest `connectors_required`. Re-read per prompt so
 *      a manifest change takes effect without restarting the session — and read
 *      for the agent this prompt actually runs, not the one the session booted
 *      with, matching how the secret grant already resolves (see secret-grant.ts).
 *   3. The session's existing binding rows. A warm-claimed session gets none, and
 *      `PUT /scope` replaces them wholesale, so this source alone would miss the
 *      common case — but it catches an alias that WAS connected at create and has
 *      since been revoked, which the other two do not.
 *
 * FAIL CLOSED ON THE VERDICT, NEVER ON THE LOOKUP. Only a positive "this alias
 * has no usable profile" may refuse the prompt. A git blip or a DB error means we
 * could not establish the answer, which is a 503 the client retries — never a 409
 * telling somebody to connect an account that is, in fact, already connected.
 */

import {
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { loadProjectAgents, requiredConnectorsForAgent } from '../agents';
import { effectiveRunningAgent } from './secret-grant';
import type { ConnectorAuthorizationRequiredProfile } from '@kortix/api-contract';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import {
  RequiredConnectorProfileUnavailableError,
  missingRequiredConnectorAuthorizationsForSession,
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
  | { ok: false; kind: 'authorization_required'; profiles: ConnectorAuthorizationRequiredProfile[] }
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
  boundAliases: readonly string[];
}): string[] {
  const seen = new Set<string>();
  for (const raw of [
    ...(input.sessionRequired ?? []),
    ...input.manifestRequired,
    ...input.boundAliases,
  ]) {
    const alias = canonicalConnectorAlias(String(raw ?? '').trim());
    if (alias) seen.add(alias);
  }
  return [...seen];
}

export async function missingPromptConnectorAuthorizations(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  sessionAgent: string;
  requestedAgent: string | null;
}): Promise<PromptConnectorVerdict> {
  let aliases: string[];
  try {
    const [[session], boundRows, [project]] = await Promise.all([
      db
        .select({ requiredConnectors: projectSessions.requiredConnectors })
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
        .select({ alias: projectSessionConnectorBindings.connectorAlias })
        .from(projectSessionConnectorBindings)
        .where(
          and(
            eq(projectSessionConnectorBindings.sessionId, input.sessionId),
            eq(projectSessionConnectorBindings.projectId, input.projectId),
            eq(projectSessionConnectorBindings.accountId, input.accountId),
          ),
        ),
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

    // A project with no default branch has no manifest to read — the other two
    // sources still stand on their own.
    let manifestRequired: string[] = [];
    if (project?.defaultBranch) {
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
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath ?? 'kortix.yaml',
          gitAuthToken: null,
        },
        { rethrowReadErrors: true },
      );
      manifestRequired = requiredConnectorsForAgent(
        effectiveRunningAgent(input.requestedAgent, input.sessionAgent),
        loaded,
      );
    }

    aliases = unionRequiredAliases({
      sessionRequired: session?.requiredConnectors,
      manifestRequired,
      boundAliases: boundRows.map((row) => row.alias),
    });
  } catch (err) {
    throw new PromptConnectorPreflightUnresolved(err);
  }

  // The overwhelmingly common case, and it costs nothing beyond the reads above:
  // no alias is required, so there is nothing to resolve per-alias.
  if (aliases.length === 0) return { ok: true };

  try {
    const missing = await missingRequiredConnectorAuthorizationsForSession({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      aliases,
    });
    return missing.length === 0
      ? { ok: true }
      : { ok: false, kind: 'authorization_required', profiles: missing };
  } catch (err) {
    // The one throw from that helper that IS a verdict rather than a failure.
    if (err instanceof RequiredConnectorProfileUnavailableError) {
      return { ok: false, kind: 'unavailable', aliases: err.aliases };
    }
    throw new PromptConnectorPreflightUnresolved(err);
  }
}
