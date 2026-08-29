/**
 * "Is this a SELF-HOST OPERATOR" — the narrower half of "platform admin".
 *
 * Pure, and deliberately in its own module with NO database or config import,
 * so it can be unit-tested without booting the server's env validation.
 * `platform-roles.ts` (which does import the db) consumes it.
 *
 * ## Why this exists
 *
 * `isPlatformAdmin` is true for two populations that must NOT be treated alike
 * wherever the managed-git ORG is concerned:
 *
 *  - the **self-host operator**, admitted by the `KORTIX_PLATFORM_ADMIN_EMAILS`
 *    allowlist. `MANAGED_GIT_GITHUB_OWNER` is their own org.
 *  - a **cloud platform admin**, admitted by a `platform_user_roles` row. On
 *    cloud that owner is `managed-kortix`, which holds EVERY customer's project
 *    repository.
 *
 * The managed-git PAT import path (the synthetic `pat` installation in
 * `serializeGitHubInstallations`) lists that owner's repositories wholesale.
 * Gating it on `isPlatformAdmin` therefore offered every customer's private
 * repository to any Kortix staff admin, one click from `/new` — reported
 * 2026-08-29 as "why can I import anyone else's project". It must ask THIS
 * question instead.
 *
 * The allowlist is the right gate because, per `getPlatformRole`'s own comment,
 * it is "Unset on cloud, so it is inert there" — precisely the property an
 * operator-only capability needs.
 */

/** The configured operator emails, normalized. Empty on cloud. */
export function selfHostOperatorAllowlist(
  raw = process.env.KORTIX_PLATFORM_ADMIN_EMAILS,
): string[] {
  return (raw || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True only for an email on the allowlist.
 *
 * A blank or missing email is never a match — otherwise an account with no
 * email could pair with an empty allowlist entry and slip through.
 */
export function isSelfHostOperatorEmail(
  email: string | null | undefined,
  raw = process.env.KORTIX_PLATFORM_ADMIN_EMAILS,
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return selfHostOperatorAllowlist(raw).includes(normalized);
}
