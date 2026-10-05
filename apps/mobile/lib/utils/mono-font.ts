/**
 * The app's monospace family: Roobert Mono Regular, loaded by `useFonts` from
 * `lib/utils/fonts.ts` (the same face web renders code in).
 *
 * Use this for every code, diff, path, and identifier text. Never hard-code
 * `'Menlo'`, `'Courier'`, or `'monospace'`: Android has no Menlo, and the
 * platform monospace faces differ in width between iOS and Android.
 *
 * Kept apart from `fonts.ts` so pure modules and bun tests can import it
 * without requiring the font binaries.
 */
export const MONO_FONT_FAMILY = 'RoobertMono-Regular';
