/**
 * fileIconKey — which glyph a file name gets (Jay, 2026-09-22). Every web
 * language has its own: `.tsx`, `.ts`, `.js`, `.jsx`, `.html`, `.css`, `.vue`.
 * The Kortix files (`kortix.html`, `kortix.yaml`, …) get the Kortix mark, and
 * git's dotfiles the git glyph.
 *
 * Pure data: unit-tested. `components/files/file-icons.ts` resolves a key to
 * its icon component.
 */

export type FileIconKey =
  | 'kortix' | 'git'
  | 'tsx' | 'ts' | 'js' | 'jsx' | 'html' | 'css' | 'vue'
  | 'py' | 'rs' | 'c' | 'cpp' | 'sql' | 'code'
  | 'md' | 'txt' | 'csv' | 'ini'
  | 'png' | 'jpg' | 'svg' | 'image' | 'video' | 'audio'
  | 'pdf' | 'doc' | 'xls' | 'ppt' | 'zip' | 'archive'
  | 'lock' | 'terminal' | 'database' | 'certificate' | 'file';

const BY_EXT: Record<string, FileIconKey> = {
  tsx: 'tsx', ts: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  py: 'py', pyi: 'py', pyx: 'py', pyw: 'py',
  rs: 'rs', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  sql: 'sql',
  go: 'code', rb: 'code', erb: 'code', java: 'code', kt: 'code', kts: 'code', cs: 'code', swift: 'code',
  php: 'code', lua: 'code', hs: 'code', r: 'code', m: 'code', mm: 'code', xml: 'code', xsl: 'code',
  json: 'code', jsonc: 'code', json5: 'code',
  md: 'md', mdx: 'md', rst: 'md',
  txt: 'txt', log: 'txt', rtf: 'txt',
  csv: 'csv', tsv: 'csv',
  yaml: 'ini', yml: 'ini', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  png: 'png', jpg: 'jpg', jpeg: 'jpg', svg: 'svg',
  gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', tiff: 'image', tif: 'image', heic: 'image', heif: 'image',
  mp4: 'video', webm: 'video', avi: 'video', mov: 'video', mkv: 'video', flv: 'video', wmv: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio', mid: 'audio', midi: 'audio',
  pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc',
  xls: 'xls', xlsx: 'xls', ods: 'xls',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt',
  zip: 'zip', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', rar: 'archive', '7z': 'archive',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal', fish: 'terminal', bat: 'terminal', cmd: 'terminal', ps1: 'terminal',
  db: 'database', sqlite: 'database', sqlite3: 'database', db3: 'database',
  pem: 'certificate', crt: 'certificate', cer: 'certificate', key: 'lock',
};

const LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']);

export function fileIconKey(fileName: string): FileIconKey {
  const name = (fileName.split('/').pop() ?? fileName).toLowerCase();
  if (name === 'kortix' || name.startsWith('kortix.')) return 'kortix';
  if (name.startsWith('.git')) return 'git';
  if (name === '.env' || name.startsWith('.env.')) return 'lock';
  if (LOCK_FILES.has(name)) return 'lock';
  if (name === 'dockerfile' || name.startsWith('docker-compose')) return 'archive';
  if (name === 'makefile' || name === 'cmakelists.txt') return 'terminal';
  if (name === 'license' || name.startsWith('license.')) return 'certificate';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return BY_EXT[ext] ?? 'file';
}
