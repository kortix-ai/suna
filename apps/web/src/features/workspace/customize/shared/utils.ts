export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  const afterTerminator = raw.slice(end + 4);
  return {
    frontmatter: raw.slice(3, end).replace(/^\n/, ''),
    body: afterTerminator.replace(/^\r?\n/, ''),
  };
}




export function formatMode(mode: string): string {
  const m = mode.toLowerCase();
  if (m === 'primary') return 'Primary';
  if (m === 'subagent') return 'Subagent';
  return mode;
}

