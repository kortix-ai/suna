/** A `log.md` line: `- <ISO 8601 time> <what happened>`, as `createProjectGoal` and the CLI write it. */
const LOG_LINE = /^[-*]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/;

export type GoalLogBlock = { kind: 'entry'; at: string; text: string } | { kind: 'text'; markdown: string };

/**
 * log.md as blocks in file order: each timed line is an entry, and the
 * Markdown between entries (a handover, a heading, notes) stays one text
 * block with its spacing. An indented line right under an entry continues it.
 */
export function parseGoalLog(markdown: string): GoalLogBlock[] {
  const blocks: GoalLogBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    const md = text.join('\n').trim();
    if (md) blocks.push({ kind: 'text', markdown: md });
    text = [];
  };
  let fenced = false;
  for (const line of markdown.replace(/^\s*# [^\n]*\n+/, '').split('\n')) {
    // A fenced code block is text as written, timestamps and all.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced || /^\s*(```|~~~)/.test(line) ? null : LOG_LINE.exec(line.trim());
    const last = blocks.at(-1);
    if (match && Number.isFinite(Date.parse(match[1]!))) {
      flush();
      blocks.push({ kind: 'entry', at: match[1]!, text: match[2]!.trim() });
    } else if (!fenced && /^\s+\S/.test(line) && !text.length && last?.kind === 'entry') {
      last.text += `\n${line.trim()}`;
    } else {
      text.push(line);
    }
  }
  flush();
  return blocks;
}
