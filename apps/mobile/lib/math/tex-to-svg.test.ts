import { describe, expect, test } from 'bun:test';
import { inlineEquationTags, texToSvg } from './tex-to-svg';

describe('texToSvg', () => {
  test('inline E = mc^2 has the TeX font metrics', () => {
    const svg = texToSvg('E = mc^2', false);
    expect(svg).toMatchObject({ width: 3845.1, height: 844.9, depth: 11 });
  });

  test('display math reports its depth below the baseline', () => {
    const svg = texToSvg('\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', true);
    expect(svg.width).toBe(8244);
    expect(svg.height).toBe(2431.9);
    expect(svg.depth).toBe(911.9);
  });

  test('markup is react-native-svg ready: one root, currentColor, no browser-only attributes', () => {
    const { xml } = texToSvg('\\frac{a}{b} + \\sqrt{x^2+1}', false);
    expect(xml.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    expect(xml.endsWith('</svg>')).toBe(true);
    expect(xml).toContain('fill="currentColor"');
    expect(xml).not.toMatch(/ data-[a-zA-Z-]+=/);
    expect(xml).not.toMatch(/<svg[^>]* (?:style|width|height|role|focusable)=/);
    expect(xml).not.toContain('<use');
    expect(xml).not.toContain('ex"');
  });

  test('stretchy constructs keep nested svg sizes but lose data attributes', () => {
    const { xml } = texToSvg('\\overbrace{a+b}^{n}', true);
    expect(xml.match(/<svg/g)?.length).toBeGreaterThan(1);
    expect(xml).not.toMatch(/ data-[a-zA-Z-]+=/);
  });

  test('an equation tag renders after the formula at a fixed size', () => {
    // MathJax lays tagged equations out at 100% width with no root viewBox and
    // a camel-case `data-mjx-viewBox`; a fixed-size SvgXml cannot draw that.
    for (const tex of [
      '\\tag{1} x',
      'E = mc^2 \\tag*{eq. 2}',
      '\\begin{align} a &= b \\nonumber \\\\ c &= d \\tag{3} \\end{align}',
    ]) {
      const svg = texToSvg(tex, true);
      expect(svg.xml.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
      expect(svg.xml).not.toContain('preserveAspectRatio');
      expect(svg.xml).not.toMatch(/ data-[a-zA-Z-]+=/);
      expect(svg.width).toBeGreaterThan(texToSvg('x', true).width);
    }
  });

  test('inlineEquationTags rewrites \\tag, \\tag*, \\nonumber, and \\notag only', () => {
    expect(inlineEquationTags('x \\tag{1}')).toBe('x \\qquad(\\text{1})');
    expect(inlineEquationTags('x \\tag*{a {b}}')).toBe('x \\qquad\\text{a {b}}');
    expect(inlineEquationTags('a \\notag \\\\ b \\nonumber')).toBe('a  \\\\ b ');
    expect(inlineEquationTags('\\\\tag \\tagx \\tag{')).toBe('\\\\tag \\tagx \\tag{');
  });

  test('a link keeps its content as a group', () => {
    const { xml } = texToSvg('\\href{https://kortix.com}{x}', false);
    expect(xml).not.toContain('<a');
    expect(xml).toContain('<path');
  });

  test('an unknown macro throws, so the caller shows the raw TeX', () => {
    expect(() => texToSvg('\\notamacro x', true)).toThrow('Undefined control sequence \\notamacro');
  });

  test('a formula that is still streaming throws', () => {
    expect(() => texToSvg('\\frac{a}{', true)).toThrow('Missing close brace');
    expect(() => texToSvg('\\begin{aligned} a &= b', true)).toThrow();
  });

  test('KaTeX-only names render: \\bm, \\argmax, \\argmin, \\vcentcolon', () => {
    for (const tex of ['\\bm{x}', '\\argmax_x f(x)', '\\argmin_\\theta L', 'a \\vcentcolon= b']) {
      expect(texToSvg(tex, true).width).toBeGreaterThan(0);
    }
  });

  test('inline and display results are cached separately', () => {
    const inline = texToSvg('\\sum_{i=1}^n i', false);
    const display = texToSvg('\\sum_{i=1}^n i', true);
    expect(texToSvg('\\sum_{i=1}^n i', false)).toBe(inline);
    expect(display).not.toBe(inline);
    expect(display.height).toBeGreaterThan(inline.height);
  });
});

// Every expression here renders with web's KaTeX 0.16 (`throwOnError: true`,
// `strict: 'ignore'`, display mode). 362 of 384 probed KaTeX expressions; the
// 22 left out are KaTeX-only extensions (\KaTeX, \raisebox, \verb, CD, \url,
// \gdef, \overgroup, \sout, \angl, \phase, …) that fall back to raw TeX here.
const KATEX_RENDERS = [
  '\\operatorname{argmax}_x f(x)',
  '\\mathbb{R}^n',
  '\\mathcal{L}',
  '\\mathscr{F}',
  '\\mathfrak{g}',
  '\\bm{x}',
  '\\boldsymbol{\\theta}',
  '\\text{if } x > 0',
  '\\textbf{bold}',
  '\\cancel{x}',
  '\\color{red}{x}',
  '\\textcolor{blue}{y}',
  '\\coloneqq',
  '\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}',
  '\\begin{array}{c|c} a & b \\\\ \\hline c & d \\end{array}',
  '\\xrightarrow{f}',
  '\\overbrace{a+b}^{n}',
  '\\underbrace{x}_{y}',
  '\\dfrac{1}{2}',
  '\\tfrac{1}{2}',
  '\\binom{n}{k}',
  '\\lVert x \\rVert',
  '\\langle a, b \\rangle',
  '\\iint',
  '\\oint',
  '\\nabla \\cdot \\vec{E}',
  '\\hat{y}',
  '\\widehat{abc}',
  '\\overline{x}',
  '\\tag{1} x',
  '\\begin{align} a &= b \\\\ c &= d \\end{align}',
  '\\begin{gather} a \\\\ b \\end{gather}',
  '\\begin{split} a &= b \\end{split}',
  '\\begin{cases} 1 & x \\end{cases}',
  '\\begin{dcases} 1 & x \\end{dcases}',
  '\\mathrm{d}x',
  '\\degree',
  '\\checkmark',
  '\\therefore',
  '\\implies',
  '\\iff',
  '\\lim_{x \\to 0}',
  '\\sqrt[3]{x}',
  '\\pmod{n}',
  '\\bigl( x \\bigr)',
  '\\left\\{ x \\right.',
  '\\overset{!}{=}',
  '\\stackrel{def}{=}',
  '\\set{x}',
  '\\def\\foo{x}\\foo',
  '\\phantom{x}',
  '\\hspace{1em}',
  '\\LaTeX',
  '\\emptyset',
  '\\varnothing',
  '\\mathbf{1}',
  '\\sum\\limits_{i}',
  '\\smallint',
  '\\argmax',
  '\\Set{x}',
  '\\bra{x}',
  '\\vcentcolon',
  '\\htmlClass{a}{x}',
  '\\boxed{x}',
  '\\argmin',
  '\\href{https://a}{x}',
  '\\operatorname*{lim}',
  '\\begin{matrix}a\\end{matrix}',
  '\\begin{aligned}a&=b\\end{aligned}',
  '\\ket{x}',
  '\\braket{a|b}',
  '\\text{é}',
  '\\textit{x}',
  '\\mathsf{x}',
  '\\mathtt{x}',
  '\\not=',
  '\\neq',
  '\\le',
  '\\ge',
  '\\approx',
  '\\infty',
  '\\partial',
  '\\cdots',
  '\\ldots',
  '\\vdots',
  '\\ddots',
  '\\forall',
  '\\exists',
  '\\in',
  '\\notin',
  '\\subseteq',
  '\\cup',
  '\\cap',
  '\\to',
  '\\mapsto',
  '\\Rightarrow',
  '\\leftarrow',
  '\\uparrow',
  '\\pm',
  '\\times',
  '\\div',
  '\\circ',
  '\\bullet',
  '\\star',
  '\\dagger',
  '\\ell',
  '\\hbar',
  '\\Re',
  '\\Im',
  '\\aleph',
  '\\top',
  '\\bot',
  '\\angle',
  '\\triangle',
  '\\square',
  '\\blacksquare',
  '\\lfloor x \\rfloor',
  '\\lceil x \\rceil',
  '\\|x\\|',
  '\\vert x \\vert',
  '\\mid',
  '\\parallel',
  '\\perp',
  '\\propto',
  '\\sim',
  '\\simeq',
  '\\cong',
  '\\equiv',
  '\\ll',
  '\\gg',
  '\\prec',
  '\\succ',
  '\\oplus',
  '\\otimes',
  '\\odot',
  '\\wedge',
  '\\vee',
  '\\neg',
  '\\lnot',
  '\\land',
  '\\lor',
  '\\S',
  '\\P',
  '\\copyright',
  '\\pounds',
  '\\yen',
  '\\mho',
  '\\operatorname{sgn}',
  '\\max',
  '\\min',
  '\\sup',
  '\\inf',
  '\\log',
  '\\ln',
  '\\exp',
  '\\sin',
  '\\det',
  '\\gcd',
  '\\Pr',
  '\\bmod',
  '\\xleftarrow{a}',
  '\\overrightarrow{AB}',
  '\\underline{x}',
  '\\tilde{x}',
  '\\bar{x}',
  '\\dot{x}',
  '\\ddot{x}',
  '\\breve{x}',
  '\\check{x}',
  '\\acute{x}',
  '\\grave{x}',
  '\\mathring{x}',
  '\\widetilde{x}',
  '\\sqrt{x}',
  '\\frac{a}{b}',
  '\\cfrac{a}{b}',
  '\\genfrac{(}{)}{0pt}{}{a}{b}',
  '\\substack{a\\\\b}',
  '\\mathclap{x}',
  '\\llap{x}',
  '\\rlap{x}',
  '\\smash{x}',
  '\\kern1em',
  '\\mkern1mu',
  '\\quad',
  '\\qquad',
  '\\,',
  ';',
  '\\!',
  '\\displaystyle x',
  '\\textstyle x',
  '\\scriptstyle x',
  '\\tiny x',
  '\\large x',
  '\\Huge x',
  '\\colorbox{red}{x}',
  '\\fcolorbox{red}{blue}{x}',
  '\\text{\\$}',
  '\\$',
  '\\%',
  '\\&',
  '\\#',
  '\\_',
  '\\{',
  '\\}',
  '\\char"41',
  '\\alpha\\beta\\Gamma\\varepsilon',
  '\\digamma',
  '\\varkappa',
  '\\eth',
  '\\impliedby',
  '\\longleftrightarrow',
  '\\hookrightarrow',
  '\\twoheadrightarrow',
  '\\rightleftharpoons',
  '\\leadsto',
  '\\lessapprox',
  '\\nleq',
  '\\varsubsetneq',
  '\\intercal',
  '\\ltimes',
  '\\boxplus',
  '\\centerdot',
  '\\diagup',
  '\\measuredangle',
  '\\complement',
  '\\Bbbk',
  '\\nexists',
  '\\backprime',
  '\\bigstar',
  '\\lozenge',
  '\\circledS',
  '\\maltese',
  '\\yen',
  '\\checkmark',
  '\\Colonapprox',
  '\\ratio',
  '\\dblcolon',
  '\\operatornamewithlimits{x}',
  '\\mathop{x}',
  '\\mathbin{x}',
  '\\mathrel{x}',
  '\\mathord{x}',
  '\\mathinner{x}',
  '\\mathpunct{x}',
  '\\mathopen{x}',
  '\\mathclose{x}',
  '\\bigg(',
  '\\Bigg)',
  '\\vphantom{x}',
  '\\hphantom{x}',
  '\\mathstrut',
  '\\TeX',
  '\\begin{pmatrix}a\\end{pmatrix}',
  '\\begin{vmatrix}a\\end{vmatrix}',
  '\\begin{Vmatrix}a\\end{Vmatrix}',
  '\\begin{Bmatrix}a\\end{Bmatrix}',
  '\\begin{smallmatrix}a\\end{smallmatrix}',
  '\\begin{subarray}{l}a\\end{subarray}',
  '\\begin{alignat}{2}a&=b\\end{alignat}',
  '\\begin{alignedat}{2}a&=b\\end{alignedat}',
  '\\begin{gathered}a\\end{gathered}',
  '\\begin{equation}a\\end{equation}',
  '\\begin{rcases}a\\end{rcases}',
  '\\begin{darray}{c}a\\end{darray}',
  '\\htmlId{a}{x}',
  '\\htmlStyle{color:red}{x}',
  '\\htmlData{a=b}{x}',
  '\\let\\x=y',
  '\\relax',
  '\\operatorname{x}\\limits',
  '\\boxed{x}',
  '\\bcancel{x}',
  '\\xcancel{x}',
  '\\textup{x}',
  '\\textmd{x}',
  '\\textnormal{x}',
  '\\emph{x}',
  '\\mathnormal{x}',
  '\\Bbb{R}',
  '\\bold{x}',
  '\\frak{g}',
  '\\mathit{x}',
  '\\rm x',
  '\\bf x',
  '\\it x',
  '\\cal L',
  '\\sf x',
  '\\tt x',
  '\\boldsymbol x',
  '\\pmb{x}',
  '\\operatorname{\\mathbb{E}}',
  '\\vcenter{x}',
  '\\hbox{x}',
  '\\mathchoice{a}{b}{c}{d}',
  '\\nonumber',
  '\\notag',
  '\\newline',
  '\\\\',
  '\\nobreak',
  '\\allowbreak',
  '\\space',
  '\\nobreakspace',
  '\\ ',
  '\\enspace',
  '\\thinspace',
  '\\medspace',
  '\\thickspace',
  '\\negthinspace',
  '\\hskip1em',
  '\\mskip1mu',
  '\\rule{1em}{1em}',
  '\\dots',
  '\\dotsb',
  '\\dotsc',
  '\\dotsi',
  '\\dotsm',
  '\\dotso',
  '\\mathellipsis',
  '\\cdotp',
  '\\ldotp',
  '\\lvert',
  '\\rvert',
  '\\lang',
  '\\rang',
  '\\lt',
  '\\gt',
  '\\ne',
  '\\larr',
  '\\rArr',
  '\\harr',
  '\\Harr',
  '\\empty',
  '\\N',
  '\\Z',
  '\\R',
  '\\natnums',
  '\\reals',
  '\\Complex',
  '\\cnums',
  '\\alef',
  '\\alefsym',
  '\\weierp',
  '\\image',
  '\\real',
  '\\isin',
  '\\sub',
  '\\sube',
  '\\supe',
  '\\infin',
  '\\Alpha',
  '\\Beta',
  '\\thetasym',
  '\\clubs',
  '\\diamonds',
  '\\hearts',
  '\\spades',
  '\\sdot',
  '\\bull',
  '\\plusmn',
  '\\exist',
  '\\argmax',
];

describe('coverage of what web renders', () => {
  test('362 KaTeX expressions', () => {
    expect(KATEX_RENDERS).toHaveLength(362);
  });

  test('every expression web renders also renders here', () => {
    const failures: string[] = [];
    for (const tex of KATEX_RENDERS) {
      try {
        texToSvg(tex, true);
      } catch (error) {
        failures.push(`${tex}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
