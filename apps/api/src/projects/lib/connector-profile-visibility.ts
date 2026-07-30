/**
 * Which connection profiles a SESSION-BOUND caller may enumerate.
 *
 * The executor PAT injected into every sandbox carries the LAUNCHING USER's id —
 * in Kortix-as-a-Backend that is the wrapper's own credential owner, who is a
 * project manager. So `mayManageSystemProfiles` is true for it, and the profile
 * list's final rule (`return mayManageSystemProfiles` for any non-member owner)
 * handed a prompt-injected agent in end-user A's sandbox the profile_id, owner_id
 * and label of every OTHER end-user's `external` connection. From there a single
 * session create with `connector_bindings` runs as B's Gmail.
 *
 * Nothing in the session-isolation work touches this, because the escalation
 * never reads a session row — it reads the connector surface directly.
 *
 * `GET /projects/:id/secrets` already solved the same shape: a session-bound
 * token must not ENUMERATE what its session cannot use, or the narrowing that
 * scrubs values from the env still leaks their identity. This is that rule for
 * connectors.
 */

/** Owner classes a profile can have. `project` = team-shared; `member` = one
 *  person's private connection; `external` = bound by reference for one
 *  end-user, which is the KaaB shape. */
export interface ProfileOwner {
  ownerType: string;
  ownerId: string | null;
}

/**
 * @param boundProfileIds The profile ids THIS session is actually bound to, or
 *        `null` when the caller is not session-bound (a dashboard user, the
 *        wrapper's own operator credential, the CLI). `null` preserves today's
 *        behaviour exactly — this narrowing exists for sandboxes.
 */
export function sessionMayEnumerateProfile(
  profile: ProfileOwner & { profileId: string },
  boundProfileIds: ReadonlySet<string> | null,
): boolean {
  // Not session-bound → unchanged. The operator enumerating their own account's
  // profiles is the normal, intended case.
  if (boundProfileIds === null) return true;

  // Team-shared connections are visible to the whole project by construction —
  // several may exist per connector (support@, sales@) and members pick between
  // them. A sandbox seeing these leaks nothing that its own project does not
  // already publish.
  if (profile.ownerType === 'project') return true;

  // Everything else — `member` (someone's private connection) and `external`
  // (another end-user's, bound by reference) — is visible ONLY if this session
  // is actually bound to it. A session can use what it was given; it has no
  // business discovering what it was not.
  return boundProfileIds.has(profile.profileId);
}
