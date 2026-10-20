// Deterministic scoring for Lumen's eval suites (no LLM judge). Pure: the runner
// (run.ts) collects Lumen's rows, this turns them into numbers.

export type Expect = { value: boolean } | { any: string[][] } | { absent: true };
export type CitationOut = { filename: string; status: 'verified' | 'relocated' | 'unverified' };
export type CellOut = { filename: string; columnKey: string; state: string; value: unknown; citations: CitationOut[] };
export type AnswerOut = { id: string; suite: 'qa' | 'refusal'; addressed: boolean; answerMd: string; citations: CitationOut[] };
export type Case = { id: string; suite: 'qa' | 'refusal'; question: string; must_cite?: string[]; must_contain?: string[][] };

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).toLowerCase();
const truthy = (v: unknown) => v === true || /^(yes|true)\b/i.test(String(v));
const falsy = (v: unknown) => v === false || /^(no|false)\b/i.test(String(v));
const SILENT = /not (stated|addressed|specified|found|mentioned|provided)|\bnone\b|\bsilent\b|no (clause|provision|express)|does not address/i;
const groupsMatch = (s: string, groups: string[][]) => groups.every((g) => g.some((alt) => s.includes(alt.toLowerCase())));
export const REFUSAL = 'do not address this';

/** Is this cell's answer right? */
export function cellCorrect(cell: Pick<CellOut, 'state' | 'value'>, exp: Expect): boolean {
  if ('absent' in exp) return cell.state === 'not_found' || cell.value === null || falsy(cell.value) || SILENT.test(text(cell.value));
  if (cell.state === 'not_found' || cell.state === 'error' || cell.state === 'pending') return false;
  if ('value' in exp) return exp.value ? truthy(cell.value) : falsy(cell.value);
  return groupsMatch(text(cell.value), exp.any);
}

const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export function scoreExtraction(cells: CellOut[], key: Record<string, Record<string, Expect>>) {
  const failures: string[] = [];
  let total = 0, correct = 0, absentTotal = 0, absentCorrect = 0, foundTotal = 0, foundCited = 0;
  for (const [filename, cols] of Object.entries(key)) {
    for (const [columnKey, exp] of Object.entries(cols)) {
      const cell = cells.find((c) => c.filename === filename && c.columnKey === columnKey);
      total++;
      const ok = !!cell && cellCorrect(cell, exp);
      if (ok) correct++;
      else failures.push(`${filename} / ${columnKey}: got ${cell ? `${cell.state} ${JSON.stringify(cell.value)}` : 'no cell'}, want ${JSON.stringify(exp)}`);
      if ('absent' in exp) {
        absentTotal++;
        if (ok) absentCorrect++;
      } else if (ok) {
        foundTotal++;
        if (cell!.citations.some((c) => c.status !== 'unverified' && c.filename === filename)) foundCited++;
      }
    }
  }
  return {
    cells: total, correct, accuracy: ratio(correct, total),
    absent: { total: absentTotal, correct: absentCorrect },
    citedCorrectValues: { total: foundTotal, cited: foundCited, rate: ratio(foundCited, foundTotal) },
    failures,
  };
}

/** Raw = what the agent wrote (verified at the cited anchor). In source = verified or relocated. Lumen shows only those as supported. */
export function scoreCitations(all: CitationOut[]) {
  const verified = all.filter((c) => c.status === 'verified').length;
  const relocated = all.filter((c) => c.status === 'relocated').length;
  return {
    total: all.length, verified, relocated, unverified: all.length - verified - relocated,
    rawPrecision: ratio(verified, all.length), inSourceRate: ratio(verified + relocated, all.length),
    // By construction: an unverified citation is marked "not found in source", never shown as support.
    shownAsSupportedPrecision: all.length ? 1 : null,
  };
}

export function scoreAnswers(cases: Case[], answers: AnswerOut[]) {
  const failures: string[] = [];
  let qa = 0, qaFacts = 0, qaCites = 0, ref = 0, refOk = 0;
  for (const c of cases) {
    const a = answers.find((x) => x.id === c.id);
    if (c.suite === 'qa') {
      qa++;
      const facts = !!a && a.addressed && groupsMatch(a.answerMd.toLowerCase(), c.must_contain ?? []);
      const cites = !!a && (c.must_cite ?? []).every((f) => a.citations.some((x) => x.filename === f && x.status !== 'unverified'));
      if (facts) qaFacts++;
      if (cites) qaCites++;
      if (!facts || !cites) failures.push(`${c.id} ${c.question}: ${a ? `facts ${facts}, cited ${cites}` : 'no answer'}`);
    } else {
      ref++;
      const ok = !!a && (!a.addressed || a.answerMd.toLowerCase().includes(REFUSAL)) && a.citations.every((x) => x.status !== 'unverified');
      if (ok) refOk++;
      else failures.push(`${c.id} ${c.question}: ${a ? `addressed ${a.addressed}` : 'no answer'}`);
    }
  }
  return {
    qa: { cases: qa, factRecall: ratio(qaFacts, qa), citedDocRecall: ratio(qaCites, qa) },
    refusal: { cases: ref, passed: refOk },
    failures,
  };
}
