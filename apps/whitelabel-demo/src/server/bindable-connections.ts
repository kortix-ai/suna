import type { ConnectionProfile } from '@kortix/sdk';

/**
 * Which connections a WRAPPER may bind to a session it starts.
 *
 * A wrapper acts under one credential for many end-users, so it has no personal
 * identity upstream. It can therefore bind only project-owned
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
  authorizationId: string;
  connectorAlias: string;
  label: string;
  isDefault: boolean;
}

/**
 * Why an alias the project HAS connections for still has nothing to bind.
 *
 * Both answers are "ask a teammate", never "connect it yourself": a wrapper
 * credential cannot connect on an end-user's behalf, and `require_connectors`
 * — the interactive flow that would — is refused for it outright.
 */
export type ConnectorBindingUnavailable =
  'private_only' | 'project_connection_inactive';

export interface ConnectorBindingChoice {
  alias: string;
  /** Everything a wrapper may bind for this alias. Empty ⇒ see `unavailable`. */
  connections: BindableConnection[];
  unavailable: ConnectorBindingUnavailable | null;
}

export function selectBindableConnections(
  profiles: ConnectionProfile[] | undefined,
  connectorAlias: string,
): BindableConnection[] {
  return (profiles ?? [])
    .filter(
      (profile) =>
        profile.connector_alias === connectorAlias &&
        // Project-owned only — see above.
        profile.owner_type === 'project' &&
        // A revoked or errored connection binds "successfully" and then fails at
        // the first tool call, which is a worse experience than not offering it.
        profile.status === 'active',
    )
    .map((profile) => ({
      authorizationId: profile.profile_id,
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

/**
 * Every connector alias the project has connections for, each with what this
 * wrapper may actually bind — including the aliases where the answer is
 * "nothing".
 *
 * The empty ones matter most. An alias whose only connections are members'
 * PRIVATE ones looks connected from the inside (a teammate connected it, in
 * their own account) and is unbindable from here, which is the single most
 * confusing thing about connectors in wrapper mode. Grouping is done over ALL
 * profiles, not just the bindable ones, precisely so that case can be named
 * rather than silently disappearing from the picker.
 */
export function selectConnectorBindingChoices(
  profiles: ConnectionProfile[] | undefined,
): ConnectorBindingChoice[] {
  const aliases = [
    ...new Set((profiles ?? []).map((profile) => profile.connector_alias)),
  ].sort((a, b) => a.localeCompare(b));

  return aliases.map((alias) => {
    const connections = selectBindableConnections(profiles, alias);
    if (connections.length > 0)
      return { alias, connections, unavailable: null };
    // A revoked or errored project connection is a different ask than a private one:
    // the project connection exists and needs reconnecting, rather than never
    // having been shared. Same actor either way — a teammate.
    // `member` is the only owner type a wrapper genuinely cannot reach — it is
    // one person's private connection. Everything else (`project`, `agent`,
    // `subject`, `external`) is a shared/system profile that the platform WILL
    // bind for a caller who may manage system profiles, so calling those
    // "only connected to people's own accounts" tells the user something false
    // AND names an action — "ask a teammate to share it" — that resolves
    // nothing. Channel/inbox installs mint `external` profiles, so this is a
    // shape that really occurs, not a hypothetical.
    const forAlias = (profiles ?? []).filter(
      (p) => p.connector_alias === alias,
    );
    const hasNonMemberProfile = forAlias.some((p) => p.owner_type !== 'member');
    return {
      alias,
      connections,
      unavailable: hasNonMemberProfile
        ? 'project_connection_inactive'
        : 'private_only',
    };
  });
}
