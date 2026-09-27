/**
 * Converts a fixed set of formulas with the app's `lib/math/tex-to-svg.ts`
 * and prints one JSON document: per formula its size, its depth, and the full
 * SVG markup (or the error message).
 *
 * `run.sh` bundles this file once and runs the SAME bundle under Bun and under
 * the Hermes VM the app ships (as source and as `hermesc -O` bytecode). Equal
 * output means MathJax parses TeX and lays out glyphs identically on Hermes.
 */
import { texToSvg } from '@/lib/math/tex-to-svg';

declare const print: ((...args: string[]) => void) | undefined;

const out = (line: string) => {
  if (typeof print === 'function') print(line);
  else console.log(line);
};

const FORMULAS: { name: string; display: boolean; tex: string }[] = [
  { name: 'inline-emc2', display: false, tex: 'E = mc^2' },
  { name: 'inline-frac', display: false, tex: '\\frac{a}{b} + \\sqrt{x^2+1}' },
  { name: 'block-gauss', display: true, tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' },
  { name: 'block-sum', display: true, tex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}' },
  {
    name: 'block-matrix',
    display: true,
    tex: 'A = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}, \\quad \\det A = a_{11}a_{22} - a_{12}a_{21}',
  },
  {
    name: 'block-aligned',
    display: true,
    tex: '\\begin{aligned} f(x) &= \\mathbb{E}[X \\mid Y] \\\\ &= \\operatorname{softmax}(\\bm{W}x + b) \\end{aligned}',
  },
  { name: 'block-cases', display: true, tex: '|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}' },
  { name: 'block-tagged', display: true, tex: 'a^2 + b^2 = c^2 \\tag{1}' },
  { name: 'error-incomplete', display: true, tex: '\\frac{a}{' },
  { name: 'error-unknown-macro', display: false, tex: '\\notamacro x' },
];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const result: Record<string, unknown> = {};
const started = now();
for (const { name, display, tex } of FORMULAS) {
  const t0 = now();
  try {
    const svg = texToSvg(tex, display);
    result[name] = { ...svg, ms: Math.round((now() - t0) * 10) / 10 };
  } catch (error) {
    result[name] = { error: String((error as Error).message), ms: Math.round((now() - t0) * 10) / 10 };
  }
}
out(JSON.stringify({ totalMs: Math.round(now() - started), formulas: result }));
