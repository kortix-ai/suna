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
  // The open fence (its run of ``` or ~~~), or null: a fenced code block is text as written, timestamps and all.
  let fence: string | null = null;
  for (const line of markdown.replace(/^\s*# [^\n]*\n+/, '').split('\n')) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    // A backtick fence's info string has no backtick: "```js``` x" is inline code, not a fence.
    const marker: string | undefined = run && (run[0] === '~' || fence !== null || !line.trim().slice(run.length).includes('`')) ? run : undefined;
    const inFence = fence !== null || !!marker;
    // A fence closes only on the same character, at least as long (CommonMark).
    if (marker && fence === null) fence = marker;
    else if (marker && marker[0] === fence![0] && marker.length >= fence!.length && !line.trim().slice(marker.length).trim()) fence = null;
    const fenced = fence !== null;
    const match = inFence ? null : LOG_LINE.exec(line.trim());
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
