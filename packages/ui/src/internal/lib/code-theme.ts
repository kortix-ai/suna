/**
 * The one syntax palette for every Shiki-rendered code surface in apps/web:
 * markdown code blocks, the docs MDX pipeline, the easy-panel file viewer and
 * the diff viewer all render under this pair.
 *
 * This module has NO imports, on purpose. `source.config.ts` is compiled by the
 * fumadocs-mdx pipeline, outside the Next.js module graph, where `@/` aliases do
 * not resolve — it reaches these constants by relative path. An import here
 * would drag the app's module graph into the docs build.
 *
 * Keeping the values in one place is the whole point: the previous duplicate in
 * `source.config.ts` drifted to a different palette AND named the wrong file in
 * its own "keep in sync" comment.
 */
export const SHIKI_THEME_DARK = 'min-dark';
export const SHIKI_THEME_LIGHT = 'min-light';

/**
 * The only two themes any code surface may render. Widening this type is how a
 * second palette would get back in — don't.
 */
export type CodeThemeName = typeof SHIKI_THEME_DARK | typeof SHIKI_THEME_LIGHT;
