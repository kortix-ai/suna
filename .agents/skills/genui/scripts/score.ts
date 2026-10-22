import { parseGenui, separateGenuiClosers, splitGenui } from '../../../../packages/sdk/src/genui/index';
import { genuiResultToMarkdown } from '../../../../packages/sdk/src/genui/markdown';

export interface EvalCase {
  id: string;
  /** `ui`: a block is the right answer. `prose`: no block. `either`: both are fine. */
  expect: 'ui' | 'prose' | 'either';
  prompt: string;
  /** Tool output given to the model as context, when the case has data. */
  context?: string;
  /** Block names that must not appear (e.g. charts when no data was given). */
  forbid?: string[];
  /** A visual answer: the fewest blocks (each after its own prose) and photos, and the components it needs. */
  rich?: { blocks: number; images?: number; needs?: string[] };
}

export interface CaseScore {
  id: string;
  blocks: number;
  validBlocks: number;
  components: string[];
  overuse: boolean;
  underuse: boolean;
  forbidden: string[];
  issues: string[];
  /** Distinct image URLs: Image.src and the image of Card, Step, RankedItem, Marker. */
  images: number;
  /** Image URLs that are not in the case context: invented or copied from the skill examples. */
  foreignImages: number;
  /** Blocks with at least 20 visible characters of prose, headings excluded, since the previous block (or the reply start). */
  interleaved: number;
  /** Visible prose characters / (prose + the toMarkdown text of every block). Reported, not gated. */
  proseShare: number;
  /** A `rich` ui case with fewer interleaved blocks or images than asked, or a needed component missing. */
  thin: boolean;
  /** Prose sections (between headings and blocks) of more than 6 sentences, in a reply with blocks: a missed Steps or Cards. Reported, not gated. */
  longProse: number;
  /** Set when the reply carries no usable content. An errored case is excluded from the rates. */
  error?: string;
}

type Node = { type: string; props: Record<string, unknown> } | null;

const chars = (text: string) => text.replace(/\s/g, '').length;
const LONG_PROSE_SENTENCES = 6;

const HEADING = /^ {0,3}#{1,6}(?:[ \t].*)?$/m;
const FENCE = /^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm;
const LIST_ITEM = /^\s*([-*]|\d+\.)\s/;
/** A table row, or a line that is only a link (a Sources list): not prose to put in a block. */
const NOT_PROSE = /^\s*(\||([-*]|\d+\.)?\s*\[[^\]]*\]\([^)]*\)\s*$)/;
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St)\./g;
const SENTENCE_END = /[.!?。！？]["'”’)\]*_]*(?=\s|$)/g;

/** Sentences in a prose run, code fences, tables, and link-only lines removed. Each list item counts as at least one. */
function sentences(text: string): number {
  return text
    .replace(FENCE, '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !NOT_PROSE.test(line))
    .reduce((sum, line) => sum + Math.max(LIST_ITEM.test(line) ? 1 : 0, line.replace(ABBREVIATION, '').match(SENTENCE_END)?.length ?? 0), 0);
}

function collect(node: Node, into: Set<string>, images: Set<string>): void {
  if (!node) return;
  into.add(node.type);
  for (const key of ['image', 'src']) if (typeof node.props[key] === 'string') images.add(node.props[key] as string);
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) collect(child as Node, into, images);
      }
    }
  }
}

/** Score one model reply against its case. Pure: no network, no clock. */
export function scoreReply(testCase: EvalCase, reply: string): CaseScore {
  // A 200 with no content is a gateway fault, not a prose answer.
  if (reply.trim() === '') {
    return {
      id: testCase.id,
      blocks: 0,
      validBlocks: 0,
      components: [],
      overuse: false,
      underuse: false,
      forbidden: [],
      issues: ['empty reply'],
      images: 0,
      foreignImages: 0,
      interleaved: 0,
      proseShare: 0,
      thin: false,
      longProse: 0,
      error: 'empty reply',
    };
  }
  const components = new Set<string>();
  const images = new Set<string>();
  const issues: string[] = [];
  let blocks = 0, validBlocks = 0, interleaved = 0, prose = 0, blockText = 0, proseSince = 0, longProse = 0;
  for (const segment of splitGenui(separateGenuiClosers(reply))) {
    if (segment.kind !== 'genui') {
      prose += chars(segment.text);
      // A heading is not prose: a heading-only section does not interleave.
      proseSince += chars(segment.text.split('\n').filter((line) => !/^\s{0,3}#/.test(line)).join('\n'));
      longProse += segment.text.split(HEADING).filter((section) => sentences(section) > LONG_PROSE_SENTENCES).length;
      continue;
    }
    blocks++;
    if (proseSince >= 20) interleaved++;
    proseSince = 0;
    const result = parseGenui(segment.code, segment.version);
    collect(result.root, components, images);
    blockText += chars(genuiResultToMarkdown(result));
    issues.push(...result.issues.map((issue) => `${issue.code}:${issue.component ?? ''}`));
    if (result.root && result.issues.length === 0) validBlocks++;
  }
  const names = [...components].sort();
  const rich = testCase.expect === 'ui' ? testCase.rich : undefined;
  return {
    id: testCase.id,
    blocks,
    validBlocks,
    components: names,
    overuse: testCase.expect === 'prose' && blocks > 0,
    underuse: testCase.expect === 'ui' && blocks === 0,
    forbidden: names.filter((name) => testCase.forbid?.includes(name)),
    issues,
    images: images.size,
    foreignImages: [...images].filter((url) => !testCase.context?.includes(url)).length,
    interleaved,
    proseShare: prose + blockText === 0 ? 0 : prose / (prose + blockText),
    thin: !!rich && (interleaved < rich.blocks || images.size < (rich.images ?? 0) || !(rich.needs ?? []).every((name) => names.includes(name))),
    longProse: blocks > 0 ? longProse : 0,
  };
}

export interface ModelSummary {
  model: string;
  cases: number;
  blocks: number;
  validRate: number;
  overuseRate: number;
  underuseRate: number;
  forbiddenCount: number;
  medianCompletionTokens: number;
  /** Cases whose reply was empty. Any error fails the gate. */
  errorCount: number;
  /** Thin cases / non-errored ui cases with a `rich` bar. */
  thinRate: number;
  /** Image URLs not in the case context, summed over cases. */
  foreignImageCount: number;
  /** Median proseShare over non-errored ui cases with at least 1 block. Reported, not gated. */
  medianProseShare: number;
  /** longProse summed over cases. Reported, not gated. */
  longProseCount: number;
  go: boolean;
}

/** Go/no-go thresholds from plan-2. */
export const GATE = { validRate: 0.97, overuseRate: 0.1, underuseRate: 0.25, forbiddenCount: 1, thinRate: 0.25, foreignImageCount: 0 } as const;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
};

export function summarize(model: string, cases: EvalCase[], scores: CaseScore[], completionTokens: number[]): ModelSummary {
  const expectOf = new Map(cases.map((c) => [c.id, c.expect]));
  const richIds = new Set(cases.filter((c) => c.expect === 'ui' && c.rich).map((c) => c.id));
  const scored = scores.filter((s) => !s.error);
  const prose = scored.filter((s) => expectOf.get(s.id) === 'prose');
  const ui = scored.filter((s) => expectOf.get(s.id) === 'ui');
  const rate = (hits: number, of: number) => (of === 0 ? 0 : hits / of);
  const blocks = scores.reduce((sum, s) => sum + s.blocks, 0);
  const valid = scores.reduce((sum, s) => sum + s.validBlocks, 0);
  const rich = scored.filter((s) => richIds.has(s.id));
  const summary = {
    model,
    cases: scores.length,
    blocks,
    validRate: blocks === 0 ? 0 : valid / blocks,
    overuseRate: rate(prose.filter((s) => s.overuse).length, prose.length),
    underuseRate: rate(ui.filter((s) => s.underuse).length, ui.length),
    forbiddenCount: scores.reduce((sum, s) => sum + s.forbidden.length, 0),
    medianCompletionTokens: median(completionTokens),
    errorCount: scores.length - scored.length,
    thinRate: rate(rich.filter((s) => s.thin).length, rich.length),
    foreignImageCount: scores.reduce((sum, s) => sum + s.foreignImages, 0),
    medianProseShare: median(ui.filter((s) => s.blocks > 0).map((s) => s.proseShare)),
    longProseCount: scores.reduce((sum, s) => sum + s.longProse, 0),
  };
  return {
    ...summary,
    go:
      summary.errorCount === 0 &&
      summary.validRate >= GATE.validRate &&
      summary.overuseRate <= GATE.overuseRate &&
      summary.underuseRate <= GATE.underuseRate &&
      summary.forbiddenCount <= GATE.forbiddenCount &&
      summary.thinRate <= GATE.thinRate &&
      summary.foreignImageCount <= GATE.foreignImageCount,
  };
}
