export const MEMORY_VERBS: Record<string, string> = {
  view: 'View',
  create: 'Create',
  str_replace: 'Edit',
  insert: 'Insert',
  delete: 'Delete',
  rename: 'Rename',
};

export function memoryRelPath(p?: string): string {
  if (!p) return '';
  const rel = p.replace(/^\.kortix\/memory\/?/, '').replace(/\/$/, '');
  return rel || 'memory';
}

interface MemoryDirEntry {
  path: string;
  size: string;
  isDir: boolean;
}

export function parseMemoryView(
  output: string,
  viewedPath: string,
): { type: 'dir'; entries: MemoryDirEntry[] } | { type: 'file'; content: string } | null {
  if (!output) return null;
  const nl = output.indexOf('\n');
  const header = nl === -1 ? output : output.slice(0, nl);
  const body = nl === -1 ? '' : output.slice(nl + 1);

  if (/content of .* with line numbers/i.test(header)) {
    const content = body
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\t/, ''))
      .join('\n');
    return { type: 'file', content };
  }

  if (/files and directories/i.test(header)) {
    const root = viewedPath.replace(/\/$/, '');
    const entries: MemoryDirEntry[] = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const size = line.slice(0, tab).trim();
      const path = line.slice(tab + 1).trim();
      if (path === root) continue;
      entries.push({ size, path, isDir: !/\.\w+$/.test(path) });
    }
    return { type: 'dir', entries };
  }

  return null;
}
