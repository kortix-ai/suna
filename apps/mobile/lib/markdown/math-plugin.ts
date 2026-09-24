/**
 * markdown-it math syntax that pairs `$` delimiters the way web does.
 *
 * Web parses chat markdown with remark-math 6 (micromark-extension-math) and
 * `singleDollarTextMath: true`. These rules reproduce its token boundaries so
 * the same text becomes math on both clients:
 *
 * - `math_inline`: a run of N dollars closes only on a run of exactly N
 *   dollars, like a code span. `$x$`, `$$x$$` on one line, and `$$$x$$$` are
 *   all inline math. Content is raw: backslash escapes inside it are not
 *   processed. One leading and one trailing space are stripped when both
 *   exist. An opener with no closer stays literal text.
 * - `math_block`: a line that starts with 2+ dollars (indented at most 3
 *   columns) and has no other `$` opens display math. It ends at a line of at
 *   least as many dollars; text after the opener is ignored meta. Blank lines
 *   do not end it. An unclosed block runs to the end of its container, so a
 *   formula that is still streaming renders what has arrived.
 *
 * Run `prepareMarkdownForMath` (`@kortix/shared`) on the text first: it
 * escapes currency dollars and rewrites `\(…\)` / `\[…\]` delimiters.
 *
 * Tokens carry the raw TeX in `content`; the renderer turns it into SVG.
 */

const DOLLAR = 0x24;

/** The subset of markdown-it's `StateInline` these rules read and write. */
interface InlineState {
  src: string;
  pos: number;
  posMax: number;
  pending: string;
  push(type: string, tag: string, nesting: number): MathToken;
}

/** The subset of markdown-it's `StateBlock` these rules read and write. */
interface BlockState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  skipSpaces(pos: number): number;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(type: string, tag: string, nesting: number): MathToken;
}

interface MathToken {
  content: string;
  markup: string;
  info: string;
  block: boolean;
  map: [number, number] | null;
}

type InlineRule = (state: InlineState, silent: boolean) => boolean;
type BlockRule = (state: BlockState, startLine: number, endLine: number, silent: boolean) => boolean;

/** The subset of a markdown-it instance the plugin registers on. */
export interface MathPluginHost {
  inline: { ruler: { after(afterName: string, ruleName: string, fn: InlineRule): void } };
  block: {
    ruler: {
      before(beforeName: string, ruleName: string, fn: BlockRule, options?: { alt: string[] }): void;
    };
  };
}

function mathInline(state: InlineState, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== DOLLAR) return false;

  let pos = start;
  while (pos < max && src.charCodeAt(pos) === DOLLAR) pos += 1;
  const openLength = pos - start;

  let search = pos;
  while (search < max) {
    const at = src.indexOf('$', search);
    if (at === -1 || at >= max) break;
    let end = at;
    while (end < max && src.charCodeAt(end) === DOLLAR) end += 1;
    if (end - at === openLength) {
      if (!silent) {
        let content = src.slice(pos, at);
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
          content = content.slice(1, -1);
        }
        const token = state.push('math_inline', 'math', 0);
        token.markup = '$'.repeat(openLength);
        token.content = content;
      }
      state.pos = end;
      return true;
    }
    search = end;
  }

  // No closer: the whole dollar run is text, so no dollar inside it opens math.
  if (!silent) state.pending += src.slice(start, pos);
  state.pos = pos;
  return true;
}

function mathBlock(state: BlockState, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.charCodeAt(pos) !== DOLLAR) return false;

  const openStart = pos;
  while (pos < max && state.src.charCodeAt(pos) === DOLLAR) pos += 1;
  const openLength = pos - openStart;
  if (openLength < 2) return false;

  const meta = state.src.slice(pos, max);
  if (meta.includes('$')) return false;
  if (silent) return true;

  let nextLine = startLine;
  let haveEnd = false;
  for (;;) {
    nextLine += 1;
    if (nextLine >= endLine) break;
    pos = state.bMarks[nextLine] + state.tShift[nextLine];
    max = state.eMarks[nextLine];
    // A non-blank line indented less than the container ends the block.
    if (pos < max && state.sCount[nextLine] < state.blkIndent) break;
    if (state.src.charCodeAt(pos) !== DOLLAR) continue;
    if (state.sCount[nextLine] - state.blkIndent >= 4) continue;
    const closeStart = pos;
    while (pos < max && state.src.charCodeAt(pos) === DOLLAR) pos += 1;
    if (pos - closeStart < openLength) continue;
    if (state.skipSpaces(pos) < max) continue;
    haveEnd = true;
    break;
  }

  const openerIndent = state.sCount[startLine];
  state.line = nextLine + (haveEnd ? 1 : 0);
  const token = state.push('math_block', 'math', 0);
  token.info = meta.trim();
  token.markup = '$'.repeat(openLength);
  token.block = true;
  token.content = state.getLines(startLine + 1, nextLine, openerIndent, true).replace(/\n$/, '');
  token.map = [startLine, state.line];
  return true;
}

export function mathPlugin(md: MathPluginHost): void {
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
}
