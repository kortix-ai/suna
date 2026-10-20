/** The longest channel slug the API stores. */
export const SPACE_SLUG_MAX = 40;

/**
 * A channel's slug from its name: lowercase, whitespace runs → `-`, other
 * characters dropped, `-` runs collapsed and trimmed, at most 40 characters.
 * Empty when the name has no `a-z0-9`. The API derives the stored slug with
 * this function, and the create dialog previews it, so the two never differ.
 */
export function spaceSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, SPACE_SLUG_MAX)
    .replace(/^-+|-+$/g, '');
}
