import type { ConnectorBindingChoice } from '@/server/bindable-connections';

/**
 * What to tell someone about a connector they cannot bind.
 *
 * "Your own account" vs "a teammate's team-shared account" is the thing people
 * get wrong about connectors in wrapper mode, so the copy names the distinction
 * instead of saying "no connections available".
 *
 * `selfServiceAction` is typed `null` on purpose. A wrapper acts under one
 * credential for many end-users, so there is no personal upstream identity to
 * connect WITH — the interactive flow that would do it (`require_connectors`)
 * is refused for a wrapper credential outright
 * (403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY). A "connect it yourself" button
 * here could only ever lead to that refusal, so the type forbids one existing.
 */
export interface ConnectorBindingNotice {
  title: string;
  detail: string;
  selfServiceAction: null;
}

export function connectorBindingNotice(
  choice: ConnectorBindingChoice,
): ConnectorBindingNotice | null {
  if (choice.connections.length > 0) return null;

  if (choice.unavailable === 'team_connection_inactive') {
    return {
      title: `${choice.alias} needs reconnecting`,
      detail: `The team's ${choice.alias} connection is revoked or failing, so it cannot be used. A teammate has to reconnect it — it becomes available here as soon as they do.`,
      selfServiceAction: null,
    };
  }

  return {
    title: `No shared ${choice.alias} account yet`,
    detail: `${choice.alias} is only connected to people's own accounts, which sessions started here cannot use. Once a teammate shares a ${choice.alias} connection with the team, it appears in this list.`,
    selfServiceAction: null,
  };
}
