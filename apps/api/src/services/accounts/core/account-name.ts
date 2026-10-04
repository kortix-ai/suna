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

export function defaultAccountName(
  email: string | null | undefined,
  fullName?: string | null,
): string {
  return suggestAccountName({ email, fullName });
}

// A stored name counts as "proper" only when it isn't one of the placeholder
// values migrations left behind ('Personal', 'User'). Placeholder accounts
// fall back to `defaultAccountName` — a suggested name, never the email.
export function properAccountName(name: string | null | undefined): string | null {
  const normalized = name?.trim();
  if (!normalized || normalized === 'Personal' || normalized === 'User') return null;
  return normalized;
}

export function accountDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  return properAccountName(name) ?? defaultAccountName(email);
}

export type AccountRole = 'owner' | 'admin' | 'member';
