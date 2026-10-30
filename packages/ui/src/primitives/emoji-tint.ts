/**
 * The tint a project's emoji wears.
 *
 * In the picker (emoji-picker.tsx) a cell takes a pale fill and a stronger 1px
 * inset ring while it is hovered or keyboard-active. That treatment is what a
 * project's icon now wears AT REST everywhere it appears: the card tile in
 * /projects, the switcher row in the sidebar, and the picker's own trigger
 * button in the create/edit modals.
 *
 * WHERE THE HUE COMES FROM. The picker rotates its six hues by GRID POSITION —
 * a cell's tint is a function of (column mod 6, row parity). A card tile and a
 * trigger button have no position, so that source does not exist here. The hue
 * is derived from the EMOJI instead, which also buys the property the feature
 * needs: the same project shows the same colour on every surface, with no state
 * to thread and nothing to store. 🌿 is green wherever it renders.
 *
 * TWO TIERS, deliberately lopsided:
 *
 *  1. An anchor table of ~106 emoji, below. It is not an attempt at coverage —
 *     it is the set where a MISMATCH would read as a mistake, i.e. glyphs
 *     dominated by one hue in every major vendor font (Apple, Noto, Segoe,
 *     Twemoji). A blue ring on 🔥 looks broken; a blue ring on 📝 is just a
 *     colour. Most emoji are the second kind, which is why the table stays this
 *     small and why growing it is rarely the right fix.
 *
 *  2. A hash for everything else. Deterministic, so a project's colour survives
 *     a reload and matches across surfaces, and spread across all six hues so
 *     the grid does not settle on one.
 *
 * teal is thin on purpose. Almost no emoji is unambiguously teal across
 * vendors, so rather than force marginal glyphs into it the table leaves teal
 * almost entirely to the hash, which keeps it in rotation.
 */

export const EMOJI_HUES = ['red', 'amber', 'green', 'teal', 'blue', 'violet'] as const;

export type EmojiHue = (typeof EMOJI_HUES)[number];

/**
 * Variation selectors (U+FE0E text, U+FE0F emoji) and the five Fitzpatrick skin
 * tone modifiers.
 *
 * Both have to go before anything is looked up or hashed. The same icon reaches
 * this module in more than one encoding — frimousse's `onEmojiSelect`, a row
 * loaded from the API, a value written by an older client — and '❤️' and '❤'
 * must not be two different colours. Skin tone is the same argument five times
 * over: without the strip, one gesture picks five unrelated hashes.
 */
const MODIFIERS = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

function baseOf(emoji: string): string {
  return emoji.replace(MODIFIERS, '');
}

/**
 * Emoji whose glyph is one hue in every major vendor font.
 *
 * Read with `[...string]`, which iterates CODE POINTS — so every entry here has
 * to be a single code point plus an optional variation selector. No ZWJ
 * sequences, no flags, no keycaps: those would register their halves as
 * separate anchors. emoji-tint.test.ts enforces that, and that no glyph appears
 * under two hues.
 *
 * Brown has no token of its own, so 🟤 🟫 🤎 📦 🪵 sit under amber — the
 * nearest of the six, and much nearer than a hash would land them.
 */
const DOMINANT: Record<EmojiHue, string> = {
  red: '🔴🟥❤️🩷💔🍎🍓🍒🍅🌹🌶️🩸💋🔻🚨🚒🧨🎈🐞🦞',
  amber: '🟠🟧🟡🟨🧡💛🟤🟫🤎🔥⚡⭐🌟✨☀️💡🍊🍋🍌🌽🧀🍯🏆🥇🌻🎃🦁🐯🐝🔶📦🪵',
  green: '🟢🟩💚🌿🍀🌱🌳🌲🍃🥬🥦🥑🥒🍐🍏🫑🐸🐢🐍🦖♻️✅',
  teal: '🩵🧊🫧🦚',
  blue: '🔵🟦💙🔷🔹💧🌊🌐🌍🌎🌏🐳🐋🫐🥶🌀❄️💎🦋🩻',
  violet: '🟣🟪💜🔮🍇🍆👾🪻',
};

const HUE_BY_EMOJI: ReadonlyMap<string, EmojiHue> = new Map(
  EMOJI_HUES.flatMap((hue) =>
    [...baseOf(DOMINANT[hue])].map((glyph): [string, EmojiHue] => [glyph, hue]),
  ),
);

/**
 * FNV-1a-ish, over CODE POINTS rather than UTF-16 units — the same shape
 * `chalkColors` in @kortix/shared uses for entity tiles, kept local because
 * that package exports the colours and not the hash.
 */
function hash(seed: string): number {
  let value = 0;
  for (const char of seed) value = (value * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return Math.abs(value);
}

/** The hue an emoji wears — anchored if it is loud, hashed if it is not. */
export function emojiHue(emoji: string): EmojiHue {
  const base = baseOf(emoji);

  return HUE_BY_EMOJI.get(base) ?? EMOJI_HUES[hash(base) % EMOJI_HUES.length];
}

/**
 * Every class below is a LITERAL string. Do not build one with a template
 * literal or a .map(): Tailwind v4 extracts class names by scanning source
 * TEXT, so an interpolated name emits no CSS at all and the tints silently
 * never paint. That has already happened once on this feature.
 *
 * There is no `dark:` set — each token is a light-dark() pair and :root / .dark
 * set color-scheme, so one class covers both themes.
 *
 * `border-0` is part of the tint, not the host's business: both hosts bring a
 * 1px border of their own (EntityAvatar's base class list, Button's `outline`
 * variant) and it would sit outside the inset ring as a grey second edge. The
 * picker cell has no border at all, and matching it is the point.
 */
const TINT: Record<EmojiHue, string> = {
  red: 'border-0 bg-emoji-fill-red inset-ring-1 inset-ring-emoji-ring-red',
  amber: 'border-0 bg-emoji-fill-amber inset-ring-1 inset-ring-emoji-ring-amber',
  green: 'border-0 bg-emoji-fill-green inset-ring-1 inset-ring-emoji-ring-green',
  teal: 'border-0 bg-emoji-fill-teal inset-ring-1 inset-ring-emoji-ring-teal',
  blue: 'border-0 bg-emoji-fill-blue inset-ring-1 inset-ring-emoji-ring-blue',
  violet: 'border-0 bg-emoji-fill-violet inset-ring-1 inset-ring-emoji-ring-violet',
};

/**
 * The resting fill again, under `hover:`.
 *
 * Only an INTERACTIVE host needs it. Button's `outline` variant carries
 * `hover:bg-foreground/5`, and a `:hover` rule outranks the resting
 * `bg-emoji-fill-*` on specificity, so hovering the trigger would wipe the tint
 * to a neutral wash. Restating the fill at the same modifier is what holds it.
 */
const TINT_HOVER: Record<EmojiHue, string> = {
  red: 'hover:bg-emoji-fill-red',
  amber: 'hover:bg-emoji-fill-amber',
  green: 'hover:bg-emoji-fill-green',
  teal: 'hover:bg-emoji-fill-teal',
  blue: 'hover:bg-emoji-fill-blue',
  violet: 'hover:bg-emoji-fill-violet',
};

/** The picker's active-cell treatment, at rest: fill + 1px inset ring. */
export function emojiTint(emoji: string): string {
  return TINT[emojiHue(emoji)];
}

/** Holds `emojiTint`'s fill through a host variant's own hover background. */
export function emojiTintHover(emoji: string): string {
  return TINT_HOVER[emojiHue(emoji)];
}
