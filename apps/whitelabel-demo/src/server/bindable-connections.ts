import type { ConnectionProfile } from '@kortix/sdk';

/**
 * Which connections a WRAPPER may bind to a session it starts.
 *
 * A wrapper acts under one credential for many end-users, so it has no personal
 * identity upstream. It can therefore bind only TEAM (`project`-owned)
 * connections — never a member's private one, and never another wrapper's
 * `external` one. `require_connectors`, which resolves the *acting user's own*
 * connection, is refused outright for the same reason
 * (403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY).
 *
 * Offering an unbindable connection in a picker would produce a session-create
 * failure the user cannot act on, so the filtering belongs here rather than in
 * an error message.
 */
export interface BindableConnection {
  profileId: string;
  connectorAlias: string;
  label: string;
  isDefault: boolean;
}

export function selectBindableConnections(
  profiles: ConnectionProfile[] | undefined,
  connectorAlias: string,
): BindableConnection[] {
  return (profiles ?? [])
    .filter(
      (profile) =>
        profile.connector_alias === connectorAlias &&
        // Team-shared only — see above.
        profile.owner_type === 'project' &&
        // A revoked or errored connection binds "successfully" and then fails at
        // the first tool call, which is a worse experience than not offering it.
        profile.status === 'active',
    )
    .map((profile) => ({
      profileId: profile.profile_id,
      connectorAlias: profile.connector_alias,
      label: profile.label,
      isDefault: profile.is_default,
    }))
    .sort((a, b) => {
      // Default first — it is what an unbound alias resolves to anyway, so it is
      // the honest pre-selection.
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}
