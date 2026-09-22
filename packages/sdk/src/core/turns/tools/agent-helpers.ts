import { removeTagBlocks, taskRow } from '../text-scan';

export function cleanWorkerOutput(raw: string): string {
  if (!raw) return '';
  let text = raw;

  text = text.replace(/^##\s*Worker Result\s*\n/i, '');
  text = text.replace(/^\*\*Agent:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Task:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Status:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Session:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Duration:\*\*.*\n?/m, '');

  text = removeTagBlocks(text, 'kortix_goal_system');

  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created and started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created:.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* failed to start.*$/gm, '');
  text = text.replace(/^Message sent to task.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* approved.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* cancelled.*$/gm, '');
  text = text.replace(/Worker session: ses_[a-zA-Z0-9]+/g, '');

  text = text.replace(/^---\s*\n/gm, '');
  text = text.trim();
  return text || '';
}

export function isShortOutput(cleaned: string): boolean {
  if (!cleaned) return false;
  const lines = cleaned.split('\n').filter((l) => l.trim());
  return lines.length <= 3;
}

export function extractWorkerPreview(cleaned: string): string | null {
  if (!cleaned) return null;

  const lines = cleaned.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const first = lines[0]?.replace(/^\*\*.*?\*\*\s*/, '').trim();
  if (!first) return null;
  return first.length > 120 ? first.slice(0, 120).trim() + '…' : first;
}

export function parseTaskRows(
  output: string,
): Array<{ id: string; title: string; status: string; sessionId?: string }> {
  if (!output) return [];
  const rows: Array<{ id: string; title: string; status: string; sessionId?: string }> = [];

  const lines = output.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const row = taskRow(line);
    if (row) {
      const sessionMatch = line.match(/\bses_[a-zA-Z0-9]+/);
      rows.push({ ...row, sessionId: sessionMatch?.[0] });
    }
  }
  return rows;
}
