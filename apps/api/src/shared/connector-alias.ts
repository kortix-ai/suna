/**
 * Connector alias canonicalization — deliberately DEPENDENCY-FREE.
 *
 * A connector is addressed by two spellings: the public alias a manifest author
 * writes (`email`) and the canonical slug the platform stores (`kortix_email`).
 * Three gates compare an agent's grant — the catalog, the call gate, and session
 * create — and they must all compare the SAME spelling or a grant satisfies one
 * and fails another.
 *
 * This lives in `shared/` with no imports because `iam/agent-scope` needs it and
 * `iam/` must stay free of database and project-layer dependencies. Importing it
 * from `projects/lib/session-connector-bindings` (which pulls in `shared/db`)
 * dragged a DB dependency into pure IAM code and broke an unrelated suite.
 */
const PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS: Readonly<Record<string, string>> = {
  email: 'kortix_email',
  slack: 'kortix_slack',
  meet: 'kortix_voice',
};

/** The stored slug for an alias written in either spelling. */
export function canonicalConnectorAlias(alias: string): string {
  return PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS[alias] ?? alias;
}

/** The user-facing alias for a stored slug. */
export function publicConnectorAlias(alias: string): string {
  return (
    Object.entries(PUBLIC_TO_CANONICAL_CONNECTOR_ALIAS).find(
      ([, canonical]) => canonical === alias,
    )?.[0] ?? alias
  );
}
