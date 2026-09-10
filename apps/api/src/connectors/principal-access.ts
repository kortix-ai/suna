/**
 * The ONE connector access predicate for a connector principal.
 *
 * Two inputs decide whether a principal may reach a connector:
 *
 *   1. The agent grant on its session token (`agentMayUseConnector`) — the
 *      per-agent `connectors:` list from `kortix.yaml`.
 *   2. The session's ORIGINATING CHANNEL. A session that Slack (or Teams, or
 *      email) created exists to answer on that channel; the channel connector
 *      is the agent's only way to report anything — including that its other
 *      connectors are gone. It is therefore reachable regardless of the grant.
 *      INC-2026-09-08-CONNECTOR-GATEWAY: a grant that collapsed to `[]` took
 *      the Slack connector down with everything else and left the agent mute.
 *
 * The channel allowance is deliberately narrow: only the channel connector(s)
 * for the platform that created THIS session, resolved server-side from
 * `project_sessions.metadata.source` — never from the request.
 */
import type { AgentGrant } from '@kortix/db';
import { agentMayUseConnector } from '../iam/agent-scope';

export interface ConnectorAccessPrincipal {
  agentGrant?: AgentGrant | null;
  /** Canonical slugs of the channel connector(s) that created this session. */
  channelConnectorSlugs?: readonly string[];
}

/** `slug` MUST be canonical (`canonicalConnectorAlias`). */
export function principalMayUseConnector(
  principal: ConnectorAccessPrincipal,
  slug: string,
): boolean {
  if (agentMayUseConnector(principal.agentGrant ?? null, slug)) return true;
  return principal.channelConnectorSlugs?.includes(slug) ?? false;
}

export type ConnectorDenialReason =
  | 'connector_not_assigned'
  | 'connector_not_found'
  | 'connector_not_connected'
  | 'connector_disabled'
  | 'action_not_found';

/**
 * The body a denied call answers with. `reason` is the stable machine code the
 * CLI/MCP surface already keys on; the rest is what an agent needs to fix or
 * escalate the denial instead of guessing (action item 5 of the incident):
 * which agent was checked, what it holds, which manifest revision that came
 * from, and one sentence on what to do.
 */
export function connectorDenialBody(
  reason: ConnectorDenialReason,
  input: {
    principal?: ConnectorAccessPrincipal;
    connector: string;
    action?: string | null;
  },
): Record<string, unknown> {
  const grant = input.principal?.agentGrant ?? null;
  const base = {
    ok: false as const,
    status: 'denied' as const,
    reason,
    connector: input.connector,
    ...(input.action ? { action: input.action } : {}),
  };
  switch (reason) {
    case 'connector_not_assigned':
      return {
        ...base,
        agent: grant?.agent ?? null,
        granted: grant ? grant.connectors : 'all',
        manifest_revision: grant?.manifestRevision ?? null,
        manifest_commit: grant?.manifestCommit ?? null,
        hint: grant
          ? `Agent "${grant.agent}" is not granted connector "${input.connector}". Add it to agents.${grant.agent}.connectors in kortix.yaml (or set connectors: all), then send another message so the session re-reads the manifest.`
          : `Connector "${input.connector}" is not assigned to this principal.`,
      };
    case 'connector_not_connected':
      return {
        ...base,
        hint: `Connector "${input.connector}" exists in this project but has no usable connection for this session: no credential is stored, or the app was never authorized. Run \`kortix connectors connect ${input.connector}\` or add its credential, then retry.`,
      };
    case 'connector_disabled':
      return {
        ...base,
        hint: `Connector "${input.connector}" is declared but disabled in this project.`,
      };
    case 'connector_not_found':
      return {
        ...base,
        hint: `No connector "${input.connector}" is declared in this project's kortix.yaml. Run \`kortix connectors ls\` to see what exists, or \`kortix connectors add\` to declare it.`,
      };
    case 'action_not_found':
      return {
        ...base,
        hint: `Connector "${input.connector}" has no action "${input.action ?? ''}". Run \`kortix connectors describe ${input.connector}\` to list its actions.`,
      };
  }
}
