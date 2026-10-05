/**
 * TeX → SVG for chat math, rendered natively with react-native-svg.
 *
 * Web renders math with KaTeX (HTML + CSS fonts), which React Native cannot
 * display. MathJax 4 turns the same TeX into self-contained SVG paths drawn
 * with the TeX font, the Computer Modern glyphs KaTeX also uses, so a formula
 * has the same shapes and metrics on both clients.
 *
 * Configuration:
 * - Font: `@mathjax/mathjax-tex-font`. MathJax's default font (NewCM) is never
 *   bundled: metro.config.js aliases `#default-font/` to the TeX font.
 * - `fontCache: 'none'`: every glyph is an inline path, no `<use>` references.
 * - `linebreaks.inline: false`: one formula is one SVG.
 * - Packages cover what web's KaTeX accepts. `noundefined` is left out on
 *   purpose: an unknown macro throws, and the caller shows the raw TeX in the
 *   muted colour, like KaTeX's `errorColor` on web.
 *
 * The returned XML draws with `currentColor`; pass the text colour through
 * SvgXml's `color` prop. Sizes are in thousandths of an em of the math font.
 */

// Must stay the first import: MathJax reads navigator fields while it loads.
import './mathjax-env';
import { mathjax } from '@mathjax/src/mjs/mathjax.js';
import { TeX } from '@mathjax/src/mjs/input/tex.js';
import { SVG } from '@mathjax/src/mjs/output/svg.js';
import { liteAdaptor, type LiteAdaptor } from '@mathjax/src/mjs/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js';
import '@mathjax/src/mjs/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/mjs/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/mjs/input/tex/color/ColorConfiguration.js';
import '@mathjax/src/mjs/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/mjs/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/mjs/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/mjs/input/tex/braket/BraketConfiguration.js';
import '@mathjax/src/mjs/input/tex/cases/CasesConfiguration.js';
import '@mathjax/src/mjs/input/tex/centernot/CenternotConfiguration.js';
import '@mathjax/src/mjs/input/tex/gensymb/GensymbConfiguration.js';
import '@mathjax/src/mjs/input/tex/upgreek/UpgreekConfiguration.js';
import '@mathjax/src/mjs/input/tex/unicode/UnicodeConfiguration.js';
import '@mathjax/src/mjs/input/tex/enclose/EncloseConfiguration.js';
import '@mathjax/src/mjs/input/tex/extpfeil/ExtpfeilConfiguration.js';
import '@mathjax/src/mjs/input/tex/bbox/BboxConfiguration.js';
import '@mathjax/src/mjs/input/tex/html/HtmlConfiguration.js';
import '@mathjax/src/mjs/input/tex/dsfont/DsfontConfiguration.js';
import '@mathjax/src/mjs/input/tex/configmacros/ConfigMacrosConfiguration.js';
import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/mjs/svg.js';

export const TEX_PACKAGES = [
  'base',
  'ams',
  'newcommand',
  'boldsymbol',
  'color',
  'cancel',
  'mathtools',
  'textmacros',
  'braket',
  'cases',
  'centernot',
  'gensymb',
  'upgreek',
  'unicode',
  'enclose',
  'extpfeil',
  'bbox',
  'html',
  'dsfont',
  'configmacros',
] as const;

/**
 * KaTeX built-ins that MathJax lacks or names differently, so a formula that
 * renders on web does not fall back to raw TeX here. Definitions follow
 * KaTeX's `macros.js` and `symbols.js`.
 */
export const TEX_MACROS: Record<string, string | [string, number]> = {
  bm: ['\\boldsymbol{#1}', 1],
  argmax: '\\operatorname*{arg\\,max}',
  argmin: '\\operatorname*{arg\\,min}',
  vcentcolon: '\\vcentercolon',
  ratio: '\\vcentercolon',
  operatornamewithlimits: ['\\operatorname*{#1}', 1],
  // KaTeX's HTML extension names for MathJax's html package.
  htmlClass: ['\\class{#1}{#2}', 2],
  htmlId: ['\\cssId{#1}{#2}', 2],
  htmlStyle: ['\\style{#1}{#2}', 2],
  htmlData: ['#2', 2],
  // Text and spacing commands.
  bold: ['\\mathbf{#1}', 1],
  emph: ['\\textit{#1}', 1],
  textmd: ['\\text{#1}', 1],
  relax: '',
  medspace: '\\:',
  thickspace: '\\;',
  mathellipsis: '\\ldots',
  copyright: '\\text{\u00a9}',
  pounds: '\\text{\u00a3}',
  P: '\\text{\u00b6}',
  // Blackboard-bold number sets.
  N: '\\mathbb{N}',
  Z: '\\mathbb{Z}',
  R: '\\mathbb{R}',
  natnums: '\\mathbb{N}',
  reals: '\\mathbb{R}',
  Complex: '\\mathbb{C}',
  cnums: '\\mathbb{C}',
  // HTML-entity style symbol aliases.
  empty: '\\emptyset',
  infin: '\\infty',
  lang: '\\langle',
  rang: '\\rangle',
  larr: '\\leftarrow',
  rArr: '\\Rightarrow',
  harr: '\\leftrightarrow',
  Harr: '\\Leftrightarrow',
  alef: '\\aleph',
  alefsym: '\\aleph',
  weierp: '\\wp',
  image: '\\Im',
  real: '\\Re',
  isin: '\\in',
  sub: '\\subset',
  sube: '\\subseteq',
  supe: '\\supseteq',
  Alpha: '\\mathrm{A}',
  Beta: '\\mathrm{B}',
  thetasym: '\\vartheta',
  clubs: '\\clubsuit',
  diamonds: '\\diamondsuit',
  hearts: '\\heartsuit',
  spades: '\\spadesuit',
  sdot: '\\cdot',
  bull: '\\bullet',
  plusmn: '\\pm',
  exist: '\\exists',
};

export interface TexSvg {
  /** `<svg>` markup without width/height; drawn in `currentColor`. */
  xml: string;
  /** viewBox width, thousandths of an em. */
  width: number;
  /** viewBox height, thousandths of an em. */
  height: number;
  /** Part of the height below the baseline, thousandths of an em. */
  depth: number;
}

/** Most recent conversions kept; a chat rarely shows more distinct formulas. */
const CACHE_LIMIT = 500;
const cache = new Map<string, TexSvg>();

type MathDocument = ReturnType<typeof mathjax.document>;
let adaptor: LiteAdaptor | null = null;
let mathDoc: MathDocument | null = null;

function mathDocument(): { adaptor: LiteAdaptor; mathDoc: MathDocument } {
  if (!adaptor || !mathDoc) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    mathDoc = mathjax.document('', {
      InputJax: new TeX({
        packages: [...TEX_PACKAGES],
        macros: TEX_MACROS,
        formatError: (_jax: unknown, error: Error) => {
          throw error;
        },
      }),
      OutputJax: new SVG({
        fontData: MathJaxTexFont,
        fontCache: 'none',
        linebreaks: { inline: false },
      }),
    });
  }
  return { adaptor, mathDoc };
}

/** The root element's own `viewBox` (not `data-mjx-viewBox`). */
const ROOT_VIEW_BOX = /^<svg\b[^>]* viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/;
const ROOT_TAG = /^<svg\b[^>]*>/;
/** Root attributes that only matter in a browser, or that SvgXml cannot read (`ex` sizes). */
const ROOT_DROPPED_ATTRIBUTE = / (?:style|width|height|role|focusable|aria-[a-z-]+)="[^"]*"/g;
/** `data-*` attributes, including MathJax's camel-case `data-mjx-viewBox`. */
const DATA_ATTRIBUTE = / data-[a-zA-Z-]+="[^"]*"/g;
/** `\href` wraps content in `<a>`, which SvgXml drops with its children; keep the content as a group. */
const LINK_OPEN = /<a\b[^>]*>/g;
const LINK_CLOSE = /<\/a>/g;

function convert(tex: string, display: boolean): string {
  const { adaptor: lite, mathDoc: doc } = mathDocument();
  return lite.innerHTML(doc.convert(tex, { display }));
}

/**
 * Rewrites equation labels so MathJax lays the formula out at a fixed size:
 * `\tag{1}` → `\qquad(\text{1})`, `\tag*{x}` → `\qquad\text{x}`, and
 * `\nonumber` / `\notag` are dropped. Other commands, `\\` included, stay.
 */
export function inlineEquationTags(tex: string): string {
  let out = '';
  let index = 0;
  while (index < tex.length) {
    if (tex[index] !== '\\') {
      out += tex[index];
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < tex.length && /[a-zA-Z]/.test(tex[end])) end += 1;
    if (end === index + 1) {
      // A one-character control symbol such as `\\` or `\{`.
      out += tex.slice(index, index + 2);
      index += 2;
      continue;
    }
    const name = tex.slice(index + 1, end);
    if (name === 'nonumber' || name === 'notag') {
      index = end;
      continue;
    }
    if (name !== 'tag') {
      out += tex.slice(index, end);
      index = end;
      continue;
    }
    const starred = tex[end] === '*';
    let open = starred ? end + 1 : end;
    while (tex[open] === ' ') open += 1;
    const close = tex[open] === '{' ? matchingBrace(tex, open) : -1;
    if (close === -1) {
      out += tex.slice(index, end);
      index = end;
      continue;
    }
    const label = tex.slice(open + 1, close);
    out += starred ? `\\qquad\\text{${label}}` : `\\qquad(\\text{${label}})`;
    index = close + 1;
  }
  return out;
}

/** Index of the `}` that closes the `{` at `open`, skipping escaped braces; -1 when unclosed. */
function matchingBrace(tex: string, open: number): number {
  let depth = 0;
  for (let index = open; index < tex.length; index += 1) {
    if (tex[index] === '\\') {
      index += 1;
    } else if (tex[index] === '{') {
      depth += 1;
    } else if (tex[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** viewBox numbers carry float noise (`911.9000000000001`). */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Converts TeX to SVG. Throws on invalid TeX (an unknown macro, unbalanced
 * braces, a formula that is still streaming).
 */
export function texToSvg(tex: string, display: boolean): TexSvg {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let markup = convert(tex, display);
  // A labelled equation comes back 100% wide with no root viewBox (MathJax
  // `createRoot` pwidth), which a fixed-size SvgXml cannot lay out. Web's
  // KaTeX puts the tag at the right edge; here it follows the formula.
  if (!ROOT_VIEW_BOX.test(markup)) {
    const untagged = inlineEquationTags(tex);
    if (untagged !== tex) markup = convert(untagged, display);
  }
  const root = ROOT_TAG.exec(markup);
  const viewBox = root ? ROOT_VIEW_BOX.exec(root[0]) : null;
  if (!viewBox || !root) throw new Error('MathJax returned no fixed-size SVG');

  const minY = Number(viewBox[2]);
  const width = Number(viewBox[3]);
  const height = Number(viewBox[4]);
  const xml = (root[0].replace(ROOT_DROPPED_ATTRIBUTE, '') + markup.slice(root[0].length))
    .replace(DATA_ATTRIBUTE, '')
    .replace(LINK_OPEN, '<g>')
    .replace(LINK_CLOSE, '</g>');
  const result: TexSvg = { xml, width, height, depth: round(height + minY) };

  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return result;
}
