/**
 * What to show for the connectors an agent asked a human to authorize mid-turn.
 *
 * Separate from `ConnectorRequiredNotice`, which covers the OTHER shape of the
 * same problem: a prompt REFUSED before it ran, where the remedy is connect and
 * re-send. Here the turn is already in flight — the agent minted a connect link,
 * posted it, and stopped. Nothing needs re-sending; the API tells the agent the
 * account landed and it picks up on its own.
 *
 * Pure so the copy and the "is there anything to show" decision are testable
 * without a DOM or a network.
 */

import type { SessionConnectRequest } from '@kortix/sdk';

export interface SessionConnectPrompt {
  /** Connectors still waiting on a human. Empty means render nothing. */
  pending: SessionConnectRequest[];
  /** "Gmail" · "Gmail and Slack" · "Gmail, Slack and Notion". */
  label: string;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function sessionConnectPrompt(
  requests: readonly SessionConnectRequest[] | undefined,
): SessionConnectPrompt {
  // A connector the agent asked about and a human has since connected must stop
  // rendering — the row stays on the connection forever, only `connected` moves.
  const pending = (requests ?? []).filter((request) => !request.connected);
  // Deduped by slug: an agent that retried its connect call writes the same
  // request twice and must not produce two buttons for one account.
  const bySlug = new Map<string, SessionConnectRequest>();
  for (const request of pending) if (!bySlug.has(request.slug)) bySlug.set(request.slug, request);
  const unique = [...bySlug.values()];
  return { pending: unique, label: joinNames(unique.map((request) => request.app || request.slug)) };
}
