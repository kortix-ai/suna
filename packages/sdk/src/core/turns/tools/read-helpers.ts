import { tagBodyTrimNewline, textBetween } from '../text-scan';

export interface ParsedReadOutput {
  path?: string;
  type?: 'file' | 'directory';
  content?: string;
  entries?: string[];
}

export function parseReadOutput(output: string): ParsedReadOutput | null {
  if (!output) return null;
  const pathText = textBetween(output, '<path>', '</path>');
  const path = pathText !== null ? pathText.trim() : undefined;

  const contentText = tagBodyTrimNewline(output, 'content');
  if (contentText !== null) {
    const content = contentText
      .split('\n')
      .map((l) => l.replace(/^\s*\d+:\s?/, ''))
      .join('\n');
    return { path, type: 'file', content };
  }

  const entriesText = tagBodyTrimNewline(output, 'entries');
  if (entriesText !== null) {
    const entries = entriesText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\(\d+\s+entr/i.test(l));
    return { path, type: 'directory', entries };
  }

  return null;
}
