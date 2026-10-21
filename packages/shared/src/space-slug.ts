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

/** Where every channel's folder lives in the project's Files. */
export const SPACE_CHANNELS_DIR = '/Company/Channels';

/**
 * A space's two folders in the project's Files (drive paths). A channel's are
 * shared with the project: `/Company/Channels/<slug>` and its `Memory`. A DM's
 * are in the member's own folder: `<personal>/Agents/<agent>` and
 * `<personal>/Memory/agents/<agent>`. Null for a DM without a personal folder.
 * The API (folder create, rename, the session's /drives/README.md) and the web
 * tabs read this, so both name the same folders.
 */
export function spaceDriveFolders(
  kind: 'channel' | 'dm',
  name: string,
  personalFolder: string | null,
): { files: string; memory: string } | null {
  if (kind === 'channel') {
    const files = `${SPACE_CHANNELS_DIR}/${name}`;
    return { files, memory: `${files}/Memory` };
  }
  if (!personalFolder) return null;
  return { files: `${personalFolder}/Agents/${name}`, memory: `${personalFolder}/Memory/agents/${name}` };
}
