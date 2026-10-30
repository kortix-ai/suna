/**
 * The first word of the signed-in person's name, for the first chat's greeting.
 * Reads the same Supabase `user_metadata` fields the onboarding wizard does.
 * Returns '' when there is no usable name, so the caller picks the greeting
 * without one.
 */
export function firstNameOf(metadata: Record<string, unknown> | undefined): string {
  const fullName = metadata?.full_name || metadata?.name;
  if (typeof fullName !== 'string') return '';
  return fullName.trim().split(/\s+/)[0] ?? '';
}
