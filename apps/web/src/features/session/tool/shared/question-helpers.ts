export interface ParsedQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

export function parseQuestionAnswersFromOutput(output: string, count: number): string[][] | null {
  if (!output) return null;
  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(output)) !== null) found.push(m[2]);
  if (found.length === 0) return null;
  return Array.from({ length: Math.max(count, found.length) }, (_, i) =>
    found[i] ? [found[i]] : [],
  );
}
