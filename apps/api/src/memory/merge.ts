/**
 * How `remember` adds one fact to a page body (pure). The fact becomes the
 * list line `- <fact> ⟦n⟧`: at the end of the `## <section>` it names (the
 * section is made at the end of the body when missing), or at the end.
 */

/** The source token of source number `n`: ⟦n⟧ (U+27E6 n U+27E7). */
export const sourceToken = (n: number) => `⟦${n}⟧`;

const heading = (line: string) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase() ?? null;

export function appendFact(body: string, fact: string, sourceNumber: number, section?: string): string {
  return appendLine(body, `- ${fact.replace(/\s+/g, ' ').trim()} ${sourceToken(sourceNumber)}`, section);
}

const isListLine = (text: string) => /^\s*[-*]\s/.test(text);

/** One line at the end of `## <section>` (made at the end when missing), or at the end of the body. */
function appendLine(body: string, line: string, section?: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const name = section?.replace(/\s+/g, ' ').trim();
  if (!name) return joinAppended(lines, line);
  const start = lines.findIndex((text) => heading(text) === name.toLowerCase());
  if (start === -1) return joinAppended(lines, `## ${name}\n\n${line}`);
  let end = lines.findIndex((text, index) => index > start && /^#{1,2}\s/.test(text));
  if (end === -1) end = lines.length;
  // The section's last non-blank line; the line goes right after it (a blank line between prose blocks).
  let last = end - 1;
  while (last > start && lines[last]!.trim() === '') last -= 1;
  const tight = last !== start && isListLine(lines[last]!) && isListLine(line);
  lines.splice(last + 1, 0, ...(tight ? [line] : ['', line]));
  return lines.join('\n');
}

/** `block` after `lines`: right under a list line when it is a list line, else after a blank line. */
function joinAppended(lines: string[], block: string): string {
  if (lines.length === 0) return block;
  const tight = isListLine(lines[lines.length - 1]!) && isListLine(block);
  return `${lines.join('\n')}${tight ? '\n' : '\n\n'}${block}`;
}

const bare = (text: string) => text.replace(/\s*⟦\d+⟧/g, '').trim();
const sectionName = (line: string) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim();

/** The content lines of `body` with the `## ` section each sits in. */
function sectionLines(body: string): { section: string | undefined; line: string }[] {
  const out: { section: string | undefined; line: string }[] = [];
  let section: string | undefined;
  for (const raw of body.split('\n')) {
    const name = sectionName(raw);
    if (name) section = name;
    else if (raw.trim()) out.push({ section, line: raw.trimEnd() });
  }
  return out;
}

/** The lines of a "(to confirm)" page that Confirm adds to `target`: those the target does not have (tokens aside). */
export function pendingLines(target: string, pending: string): { section: string | undefined; line: string }[] {
  const have = new Set(target.split('\n').map(bare).filter(Boolean));
  return sectionLines(pending).filter(({ line }) => !have.has(bare(line)));
}

/** The source numbers the lines cite. */
export const citedNumbers = (lines: { line: string }[]) =>
  new Set(lines.flatMap(({ line }) => [...line.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]))));

/**
 * Confirming a "(to confirm)" page: each line `pendingLines` keeps goes to the
 * end of the same `## ` section of the target (or the end). `renumber` maps
 * the pending page's source numbers to the numbers they got on the target; a
 * token with no mapping is dropped.
 */
export function mergePending(target: string, pending: string, renumber: ReadonlyMap<number, number>): string {
  let body = target;
  for (const { section, line } of pendingLines(target, pending)) {
    const renumbered = line.replace(/\s*⟦(\d+)⟧/g, (_token, n: string) => {
      const mapped = renumber.get(Number(n));
      return mapped ? ` ${sourceToken(mapped)}` : '';
    });
    body = appendLine(body, renumbered, section);
  }
  return body;
}

/**
 * An outside rewrite of a confirmed page stays append-only: the "(to confirm)"
 * page gets only the rewrite's lines that neither the page nor the pending
 * page has, citation-free, each citing the outside source `n`. Confirm then
 * adds exactly what the pending page shows.
 */
export function rewriteAdditions(target: string, pending: string, rewrite: string, n: number): string {
  const have = new Set([...target.split('\n'), ...pending.split('\n')].map(bare).filter(Boolean));
  let body = pending;
  for (const { section, line } of sectionLines(rewrite)) {
    const text = bare(line);
    if (have.has(text)) continue;
    have.add(text);
    body = appendLine(body, `${text} ${sourceToken(n)}`, section);
  }
  return body;
}
