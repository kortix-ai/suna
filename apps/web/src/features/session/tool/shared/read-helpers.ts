export interface ParsedReadOutput {
  path?: string;
  type?: 'file' | 'directory';
  content?: string;
  entries?: string[];
}

export function parseReadOutput(output: string): ParsedReadOutput | null {
  if (!output) return null;
  const pathMatch = output.match(/<path>([\s\S]*?)<\/path>/);
  const path = pathMatch ? pathMatch[1].trim() : undefined;

  const contentMatch = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  if (contentMatch) {
    const content = contentMatch[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\d+:\s?/, ''))
      .join('\n');
    return { path, type: 'file', content };
  }

  const entriesMatch = output.match(/<entries>\n?([\s\S]*?)\n?<\/entries>/);
  if (entriesMatch) {
    const entries = entriesMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\(\d+\s+entr/i.test(l));
    return { path, type: 'directory', entries };
  }

  return null;
}
