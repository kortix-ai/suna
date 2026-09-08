// Pure, and importing NOTHING — the same reason ready-poll.ts and
// sandbox-deadline-policy.ts stand alone. `pre-prompt-env-sync.ts` pulls
// secret-grant and session-title-generate for real, and those reach `config`,
// which refuses to load without SUPABASE_URL and friends; a claim about a
// string comparison should not need a database to run.
/**
 * "THIS SANDBOX'S ENV IS ALREADY SYNCED, FOR THIS AGENT."
 *
 * A queued prompt used to sync twice: once in `engine.ts` before it forwards,
 * and again here when the forward arrives. Measured on dev 2026-09-08, one
 * delivered prompt, from the API's own provision-timeline:
 *
 *   deliver total=4253ms  ...  env-sync=+569ms  delivered=+1242ms
 *   proxy   total=1241ms  ...  env-sync=+555ms  upstream=+606ms
 *
 * AND THE PREDICTION WAS WRONG, which is worth writing down. That `env-sync`
 * mark covers the whole block — the sync AND `remintGrant` after it — and the
 * cost is almost entirely the latter, whose own comment says so: the manifest
 * read is a git fetch of the project mirror, ~0.8 s on the path of every
 * prompt, made synchronous deliberately by a security review. Removing the
 * duplicate sync moved the proxy's mark from ~555 ms to ~496 ms. So this is
 * worth ~50 ms and one fewer round trip, not the ~500 ms it looked like.
 *
 * WHY THE VALUE IS NOT A BARE "1". The two syncs were not interchangeable, and
 * a naive flag would have skipped something real:
 *
 *  - This one passes `requestedAgent`, so it applies (or refuses) THAT agent's
 *    secret grant. A manifest that narrowed the grant in the previous turn must
 *    be enforced from the first call of this one, so skipping on a flag would
 *    forward against an env nobody checked for this agent.
 *  - The delivery loop retries, and `deliverWithRetry.reopen` can hand back a
 *    DIFFERENT box; a flag would skip a sync that box never had.
 *
 * So the value names both the sandbox and the agent it was synced for, and the
 * delivery loop now resolves the deliverable agent BEFORE it syncs so the two
 * are the same by construction. Anything that does not match exactly — a direct
 * browser send with no header, a retry that moved box, an agent switch mid-turn
 * — syncs as it always did. `remintGrant` below is NEVER skipped: it re-points
 * the token at the running agent and is not what the header speaks for.
 */
export const ENV_SYNCED_FOR_HEADER = 'x-kortix-env-synced-for';

/** The header value for a sync just performed. Agentless syncs are a real case
 *  (a send with no pick), so `null` is encoded rather than omitted. */
export function envSyncedForValue(externalId: string, agent: string | null): string {
  return `${externalId}|${agent ?? ''}`;
}

/**
 * Does this request still need its env synced here?
 *
 * Pure, so both branches are asserted rather than observed through a proxy.
 * Deny-by-default: anything but an exact match on this sandbox AND this agent
 * is a yes.
 */
export function needsPrePromptEnvSync(
  headers: Headers,
  externalId: string | null | undefined,
  requestedAgent: string | null,
): boolean {
  const claimed = headers.get(ENV_SYNCED_FOR_HEADER);
  if (!claimed || !externalId) return true;
  return claimed !== envSyncedForValue(externalId, requestedAgent);
}
