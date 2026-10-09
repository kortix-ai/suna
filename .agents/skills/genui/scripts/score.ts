import { parseGenui, splitGenui } from '../../../../packages/sdk/src/genui/index';

export interface EvalCase {
  id: string;
  /** `ui`: a block is the right answer. `prose`: no block. `either`: both are fine. */
  expect: 'ui' | 'prose' | 'either';
  prompt: string;
  /** Tool output given to the model as context, when the case has data. */
  context?: string;
  /** Block names that must not appear (e.g. charts when no data was given). */
  forbid?: string[];
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
}

function collect(node: { type: string; props: Record<string, unknown> } | null, into: Set<string>): Set<string> {
  if (!node) return into;
  into.add(node.type);
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) collect(child as never, into);
      }
    }
  }
  return into;
}

/** Score one model reply against its case. Pure: no network, no clock. */
export function scoreReply(testCase: EvalCase, reply: string): CaseScore {
  const blocks = splitGenui(reply).filter((segment) => segment.kind === 'genui');
  const components = new Set<string>();
  const issues: string[] = [];
  let validBlocks = 0;
  for (const block of blocks) {
    if (block.kind !== 'genui') continue;
    const result = parseGenui(block.code, block.version);
    collect(result.root, components);
    issues.push(...result.issues.map((issue) => `${issue.code}:${issue.component ?? ''}`));
    if (result.root && result.issues.length === 0) validBlocks++;
  }
  const names = [...components].sort();
  return {
    id: testCase.id,
    blocks: blocks.length,
    validBlocks,
    components: names,
    overuse: testCase.expect === 'prose' && blocks.length > 0,
    underuse: testCase.expect === 'ui' && blocks.length === 0,
    forbidden: names.filter((name) => testCase.forbid?.includes(name)),
    issues,
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
  go: boolean;
}

/** Go/no-go thresholds from plan-2. */
export const GATE = { validRate: 0.97, overuseRate: 0.1, underuseRate: 0.25, forbiddenCount: 1 } as const;

export function summarize(model: string, cases: EvalCase[], scores: CaseScore[], completionTokens: number[]): ModelSummary {
  const blocks = scores.reduce((sum, s) => sum + s.blocks, 0);
  const valid = scores.reduce((sum, s) => sum + s.validBlocks, 0);
  const proseCases = cases.filter((c) => c.expect === 'prose').length;
  const uiCases = cases.filter((c) => c.expect === 'ui').length;
  const sorted = [...completionTokens].sort((a, b) => a - b);
  const summary = {
    model,
    cases: scores.length,
    blocks,
    validRate: blocks === 0 ? 0 : valid / blocks,
    overuseRate: proseCases === 0 ? 0 : scores.filter((s) => s.overuse).length / proseCases,
    underuseRate: uiCases === 0 ? 0 : scores.filter((s) => s.underuse).length / uiCases,
    forbiddenCount: scores.reduce((sum, s) => sum + s.forbidden.length, 0),
    medianCompletionTokens: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!,
  };
  return {
    ...summary,
    go:
      summary.validRate >= GATE.validRate &&
      summary.overuseRate <= GATE.overuseRate &&
      summary.underuseRate <= GATE.underuseRate &&
      summary.forbiddenCount <= GATE.forbiddenCount,
  };
}
