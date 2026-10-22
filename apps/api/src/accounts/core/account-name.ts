/**
 * The name an account gets when nobody has chosen one yet (KRTX-638).
 *
 * Never the full email address. The old default was `"<email>'s Account"`,
 * which then sat in the sidebar, the account picker, the hub and the admin
 * console for every user who never renamed it. In order of preference:
 *
 *   1. the person's first name       → "Ada's workspace"
 *   2. no profile name              → "My workspace"
 *
 * The DOMAIN is never used: most people sign up with a consumer address, and
 * an account called "Gmail" is wrong for all of them.
 *
 * Existing chosen account names are preserved by the callers.
 */
export function suggestAccountName({
  fullName,
}: {
  email?: string | null;
  fullName?: string | null;
}): string {
  const firstName = fullName?.trim().split(/\s+/)[0];
  if (firstName) return `${capitalize(firstName)}'s workspace`;

  return "My workspace";
}

/** `full_name` / `name` from a Supabase user's metadata (OAuth fills them). */
export function profileNameFromMetadata(metadata: unknown): string | null {
  const meta = metadata as Record<string, unknown> | null | undefined;
  const name = meta?.full_name ?? meta?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function capitalize(word: string): string {
  return word.charAt(0).toLocaleUpperCase() + word.slice(1);
}

/**
 * Why a user-chosen account name is refused, or null when it is valid. The
 * name lands in emails, the admin console and third-party tools, so markup
 * (`<`, `>`) and control characters are refused at the boundary (pentest
 * 2026-07 finding 2). Rendering still escapes it everywhere.
 */
export function accountNameError(name: string | null | undefined): string | null {
  if (!name) return "name is required";
  if (name.length > 255) return "name is too long";
  // eslint-disable-next-line no-control-regex
  if (/[<>\u0000-\u001f\u007f]/.test(name)) return "name must not contain <, > or control characters";
  return null;
}
