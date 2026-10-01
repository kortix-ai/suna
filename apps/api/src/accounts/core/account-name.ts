/**
 * The name an account gets when nobody has chosen one yet (KRTX-638).
 *
 * Never the full email address. The old default was `"<email>'s Account"`,
 * which then sat in the sidebar, the account picker, the hub and the admin
 * console for every user who never renamed it. In order of preference:
 *
 *   1. the person's first name       → "Ada's workspace"
 *   2. the email's local part, as is → "ada.lovelace42"   (ada.lovelace42@gmail.com)
 *   3. nothing usable                → "My workspace"
 *
 * The DOMAIN is never used: most people sign up with a consumer address, and
 * an account called "Gmail" is wrong for all of them.
 *
 * A new user confirms or changes this on the onboarding name step
 * (`/projects`), so it is a suggestion, not a final name.
 */
export function suggestAccountName({
  email,
  fullName,
}: {
  email?: string | null;
  fullName?: string | null;
}): string {
  const firstName = fullName?.trim().split(/\s+/)[0];
  if (firstName) return `${capitalize(firstName)}'s workspace`;

  const local = email?.trim().split("@")[0]?.trim();
  if (local) return local;

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
