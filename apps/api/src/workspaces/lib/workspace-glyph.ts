/**
 * Validator for `projects.metadata.icon_glyph` — the per-workspace named glyph
 * and its colour, the alternative to an emoji.
 *
 * Every write path (provision / create-repo / link-repository / PATCH) and the
 * read path (serializeWorkspace) run values through this one function, so a value
 * that reached the column can always be rendered.
 *
 * Returning `null` means "no glyph". It never throws: a malformed glyph must
 * not fail project creation, because the icon is decoration and the workspace is
 * not. Same contract as `normalizeWorkspaceIcon` in ./workspace-icon.ts.
 */
import { type WorkspaceGlyph, isWorkspaceGlyphColor, isWorkspaceGlyphName } from '@kortix/shared';

export function normalizeWorkspaceGlyph(input: unknown): WorkspaceGlyph | null {
  // `typeof [] === 'object'` and `typeof null === 'object'`, so both need
  // excluding before any property read.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;

  // A getter on a hostile object can throw. The contract is "never throws", and
  // a validator that crashes the create path would be worse than one that
  // rejects — so the reads are guarded rather than trusted.
  let name: unknown;
  let color: unknown;
  try {
    ({ name, color } = input as { name?: unknown; color?: unknown });
  } catch {
    return null;
  }

  // No trimming and no case folding. The registry lookup on the web side is
  // exact, so ' Rocket ' and 'rocket' have no component and must not be
  // storable. This is deliberately stricter than normalizeWorkspaceIcon, which
  // DOES trim — an emoji is rendered as text, a glyph name is a key.
  if (!isWorkspaceGlyphName(name) || !isWorkspaceGlyphColor(color)) return null;

  // Rebuilt, not passed through: whatever reaches the column is what a future
  // read trusts, and returning the caller's object would let a client write
  // arbitrary extra jsonb keys alongside the two that are validated.
  return { name, color };
}
