// The run screen's words for engine steps. The engine logs its own terms
// (agent kit, repair, nudge); a lawyer reads progress. Old rows map too.

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/^Checking the agent kit$/, 'Getting the legal agents ready'],
  [/^Agent kit \S+$/, 'Legal agents ready'],
  [/^(Batch \d+|Report): starting a workspace$/, (_, who) => `${who}: starting`],
  [/^(Batch \d+|Report): asked the agent to fix (\d+) problems?$/, (_, who, n) => `${who}: ${n} result${n === '1' ? '' : 's'} sent back for correction`],
  [/^(Batch \d+|Report): the agent paused; asked it to continue$/, (_, who) => `${who}: asked the agent to continue`],
  [/^(Batch \d+|Report): the workspace failed; started a new one$/, (_, who) => `${who}: restarted after a workspace error`],
];

export function activityText(detail: string): string {
  for (const [re, to] of RULES) {
    const m = re.exec(detail);
    if (m) return typeof to === 'string' ? to : to(...m);
  }
  return detail;
}

/** A template field key as a label: `governing_law` → "Governing law". */
export const fieldLabel = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
