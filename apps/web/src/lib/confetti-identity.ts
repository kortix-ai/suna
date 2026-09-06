/**
 * Which face a workspace's confetti wears.
 *
 * A project's identity is a UNION on the server — `icon` (one emoji) XOR
 * `icon_glyph` ({ name, colour }) XOR neither — and `EntityAvatar`
 * (`components/ui/entity-avatar.tsx`) resolves it with a fixed precedence:
 * glyph, then emoji, then the label's initial. The confetti has to land on
 * the SAME face, or the particles celebrate a workspace that does not look
 * like the one on screen.
 *
 * This module is that precedence, extracted and made pure so it can be tested
 * without a DOM. `lib/confetti-shapes.ts` turns the result into the actual
 * `canvas-confetti` shapes; nothing here touches a canvas, a window, or React.
 *
 * The one rule worth restating: an UNKNOWN glyph name falls THROUGH to the
 * emoji and then to the initial, exactly as `EntityAvatar.resolveGlyph` does.
 * The server rejects names outside the catalogue, so this only fires on stale
 * cached data — a query-cache snapshot that outlived a catalogue that shrank —
 * and there the right answer is the next face down, not a blank particle.
 */
import { isProjectGlyphName, type ProjectGlyphName } from '@kortix/shared';

export type ConfettiFace =
  | { kind: 'glyph'; name: ProjectGlyphName; color: string }
  | { kind: 'emoji'; emoji: string }
  | {
      kind: 'initial';
      initial: string;
      /**
       * What `chalkColors()` must be seeded with for the particle tile to come
       * out the SAME hue as the avatar tile. See `confettiChalkSeed`.
       */
      chalkSeed: string;
    };

export interface ConfettiIdentity {
  /** `KortixProject.icon_glyph`, straight through. */
  glyph?: { name: string; color: string } | null;
  /** `KortixProject.icon` — one emoji grapheme, or null. */
  emoji?: string | null;
  /** `KortixProject.name`. Only its first character is ever used. */
  label?: string | null;
}

/**
 * The initial `EntityAvatar` would draw for this label: first character,
 * uppercased, `?` when there is nothing to take one from.
 *
 * `Array.from`, not `charAt(0)`: `charAt` returns one UTF-16 code unit, so a
 * workspace named with an astral character ("𝕂ortix", "🇮🇳 Ops") yields half a
 * surrogate pair — which renders as a replacement glyph on the tile AND as a
 * replacement glyph in every confetti particle. `EntityAvatar` still uses
 * `charAt`; that is a pre-existing bug in the tile, not one to reproduce here.
 */
export function confettiInitial(label?: string | null): string {
  const trimmed = label?.trim() ?? '';
  return (Array.from(trimmed)[0] ?? '?').toUpperCase();
}

/**
 * The seed `EntityAvatar` hashes for its chalk tile, reproduced exactly —
 * quirk included.
 *
 * `entity-avatar.tsx` writes `` chalkColors(`${label?.trim()}` || initial) ``.
 * The template literal means an ABSENT label stringifies to the seven
 * characters `undefined`, which is truthy, so the tile is hashed from the
 * literal word rather than from `initial`. Only an EMPTY-but-present label
 * falls through to the initial.
 *
 * That is a wart in the tile. It is copied here on purpose: this function's
 * entire contract is that the confetti is the same colour as the avatar it
 * came from, and "correct" seeding would make a label-less workspace throw
 * particles in a different hue from the tile it is standing next to. Fix it in
 * `entity-avatar.tsx` and this follows; do not fix it only here.
 */
export function confettiChalkSeed(label: string | null | undefined, initial: string): string {
  return `${label?.trim()}` || initial;
}

/** Resolve a project's stored identity to the single face its confetti wears. */
export function resolveConfettiFace(identity: ConfettiIdentity): ConfettiFace {
  const { glyph, emoji, label } = identity;

  if (glyph && isProjectGlyphName(glyph.name)) {
    return { kind: 'glyph', name: glyph.name, color: glyph.color };
  }

  // Trimmed, because an emoji column that holds `''` or `'   '` is "no emoji"
  // — the same falsy-falls-through contract `EntityAvatar` documents for its
  // ~30 emoji-less call sites.
  const trimmedEmoji = emoji?.trim();
  if (trimmedEmoji) return { kind: 'emoji', emoji: trimmedEmoji };

  const initial = confettiInitial(label);
  return { kind: 'initial', initial, chalkSeed: confettiChalkSeed(label, initial) };
}
