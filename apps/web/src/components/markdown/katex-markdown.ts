import { defaultSchema } from 'rehype-sanitize';
import { defaultRehypePlugins, defaultRemarkPlugins } from 'streamdown';
import type { PluggableList } from 'unified';

// ---------------------------------------------------------------------------
// KaTeX / LaTeX markdown support for Streamdown
// ---------------------------------------------------------------------------
// Streamdown ships remark-math + rehype-katex but:
//  1. Standard `\(…\)` and `\[…\]` delimiters need normalization to remark-math delimiters.
//  2. singleDollarTextMath is enabled for `$E = mc^2$` inline math; currency like `$4M` /
//     `$50K` is escaped to `\$4M` / `\$50K` in prepareMarkdownForKatex() before parsing.
//  3. Default rehype order (raw → katex → sanitize) lets sanitize strip KaTeX SVG/MathML.
//  4. rehype-sanitize's GitHub schema strips KaTeX output if order regresses.
// ---------------------------------------------------------------------------

/** MathML tags KaTeX may emit (keep in sync with KaTeX output, not hand-picked subset). */
const KATEX_MATHML_TAG_NAMES = [
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'mspace',
  'mstyle',
  'msup',
  'msub',
  'msubsup',
  'mmultiscripts',
  'mprescripts',
  'mfrac',
  'mover',
  'munder',
  'munderover',
  'msqrt',
  'mroot',
  'mtable',
  'mtr',
  'mtd',
  'mlabeledtr',
  'menclose',
  'merror',
  'mpadded',
  'mphantom',
  'mfenced',
  'mglyph',
  'maction',
  'maligngroup',
  'malignmark',
  // SVG elements for sqrt signs, fraction bars, stretchy delimiters, etc.
  'svg',
  'path',
  'line',
  'g',
  'rect',
] as const;

const katexSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), ...KATEX_MATHML_TAG_NAMES],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className', 'style', 'aria-hidden'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'fill', 'stroke'],
    path: ['d', 'fill', 'stroke', 'strokeWidth', 'stroke-width'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'stroke-width'],
    g: ['fill', 'stroke'],
    rect: ['x', 'y', 'width', 'height', 'fill', 'stroke'],
  },
};

// Delimiter preparation and math fence languages are shared with apps/mobile.
export {
  escapeCurrencyDollars,
  KATEX_FENCE_LANGUAGES,
  normalizeLatexDelimiters,
  prepareMarkdownForKatex,
} from '@kortix/shared/markdown-math';

/**
 * Remark plugins for UnifiedMarkdown.
 * Inline `$…$` math is on; currency amounts are escaped upstream via prepareMarkdownForKatex().
 */
export const katexRemarkPlugins: PluggableList = Object.entries(defaultRemarkPlugins).map(
  ([key, plugin]) => {
    if (key === 'math' && Array.isArray(plugin)) {
      const [mathPlugin, mathOpts] = plugin;
      return [
        mathPlugin,
        { ...((mathOpts as Record<string, unknown>) || {}), singleDollarTextMath: true },
      ];
    }
    return plugin;
  },
) as PluggableList;

/**
 * Build rehype plugins with sanitize BEFORE katex so KaTeX output is not stripped.
 * Streamdown default order is raw → katex → sanitize → harden (broken for fractions/sqrt).
 */
export function buildKatexRehypePlugins(includeRaw: boolean): PluggableList {
  const byKey: Record<string, PluggableList[number]> = {};
  for (const [key, plugin] of Object.entries(defaultRehypePlugins)) {
    if (key === 'sanitize' && Array.isArray(plugin)) {
      byKey[key] = [plugin[0], katexSanitizeSchema];
    } else {
      byKey[key] = plugin;
    }
  }
  const ordered: PluggableList[number][] = [];
  for (const key of ['raw', 'sanitize', 'katex', 'harden'] as const) {
    if (key === 'raw' && !includeRaw) {
      delete byKey[key];
      continue;
    }
    if (byKey[key]) {
      ordered.push(byKey[key]);
      delete byKey[key];
    }
  }
  for (const plugin of Object.values(byKey)) ordered.push(plugin);
  return ordered as PluggableList;
}

export const katexRehypePlugins = buildKatexRehypePlugins(true);
export const katexRehypePluginsNoRaw = buildKatexRehypePlugins(false);

export const KATEX_RENDER_OPTIONS = {
  throwOnError: false,
  errorColor: 'var(--color-muted-foreground)',
  strict: 'ignore' as const,
};

export function normalizeClassName(className?: string | string[]): string {
  if (!className) return '';
  return Array.isArray(className) ? className.join(' ') : className;
}

/** True when a hast/react node belongs to KaTeX output — must not get prose Tailwind overrides. */
export function isKatexClassName(className?: string | string[]): boolean {
  const cls = normalizeClassName(className);
  if (!cls) return false;
  return /\b(katex|katex-display|katex-html|katex-mathml|katex-error|math-inline|math-display)\b/.test(
    cls,
  );
}
