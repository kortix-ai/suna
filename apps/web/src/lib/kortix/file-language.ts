export type LanguageMeta = { name: string; color: string };

const EXT_MAP: Record<string, LanguageMeta> = {
  ts: { name: 'TypeScript', color: '#3178c6' },
  tsx: { name: 'TypeScript', color: '#3178c6' },
  js: { name: 'JavaScript', color: '#f1e05a' },
  jsx: { name: 'JavaScript', color: '#f1e05a' },
  mjs: { name: 'JavaScript', color: '#f1e05a' },
  cjs: { name: 'JavaScript', color: '#f1e05a' },
  py: { name: 'Python', color: '#3572A5' },
  rb: { name: 'Ruby', color: '#701516' },
  go: { name: 'Go', color: '#00ADD8' },
  rs: { name: 'Rust', color: '#dea584' },
  java: { name: 'Java', color: '#b07219' },
  kt: { name: 'Kotlin', color: '#A97BFF' },
  swift: { name: 'Swift', color: '#F05138' },
  c: { name: 'C', color: '#555555' },
  h: { name: 'C', color: '#555555' },
  cpp: { name: 'C++', color: '#f34b7d' },
  cc: { name: 'C++', color: '#f34b7d' },
  hpp: { name: 'C++', color: '#f34b7d' },
  cs: { name: 'C#', color: '#178600' },
  php: { name: 'PHP', color: '#4F5D95' },
  lua: { name: 'Lua', color: '#000080' },
  sh: { name: 'Shell', color: '#89e051' },
  bash: { name: 'Shell', color: '#89e051' },
  zsh: { name: 'Shell', color: '#89e051' },
  fish: { name: 'Shell', color: '#89e051' },
  ps1: { name: 'PowerShell', color: '#012456' },

  html: { name: 'HTML', color: '#e34c26' },
  htm: { name: 'HTML', color: '#e34c26' },
  css: { name: 'CSS', color: '#563d7c' },
  scss: { name: 'SCSS', color: '#c6538c' },
  sass: { name: 'Sass', color: '#a53b70' },
  less: { name: 'Less', color: '#1d365d' },
  vue: { name: 'Vue', color: '#41b883' },
  svelte: { name: 'Svelte', color: '#ff3e00' },

  json: { name: 'JSON', color: '#d19a66' },
  yaml: { name: 'YAML', color: '#cb171e' },
  yml: { name: 'YAML', color: '#cb171e' },
  toml: { name: 'TOML', color: '#9c4221' },
  xml: { name: 'XML', color: '#0060ac' },

  md: { name: 'Markdown', color: '#083fa1' },
  mdx: { name: 'MDX', color: '#1e88e5' },
  txt: { name: 'Text', color: '#a0a0a0' },
  rst: { name: 'reST', color: '#141414' },

  sql: { name: 'SQL', color: '#e38c00' },
  prisma: { name: 'Prisma', color: '#0c344b' },
  graphql: { name: 'GraphQL', color: '#e10098' },
  gql: { name: 'GraphQL', color: '#e10098' },
  proto: { name: 'Protobuf', color: '#7c4dff' },

  dockerfile: { name: 'Docker', color: '#384d54' },
  makefile: { name: 'Makefile', color: '#427819' },

  png: { name: 'Image', color: '#a371f7' },
  jpg: { name: 'Image', color: '#a371f7' },
  jpeg: { name: 'Image', color: '#a371f7' },
  gif: { name: 'Image', color: '#a371f7' },
  webp: { name: 'Image', color: '#a371f7' },
  svg: { name: 'SVG', color: '#FFB13B' },
  ico: { name: 'Image', color: '#a371f7' },

  pdf: { name: 'PDF', color: '#b30b00' },
  zip: { name: 'Archive', color: '#6e7781' },
  tar: { name: 'Archive', color: '#6e7781' },
  gz: { name: 'Archive', color: '#6e7781' },

  csv: { name: 'CSV', color: '#237346' },
  tsv: { name: 'CSV', color: '#237346' },
  xlsx: { name: 'Excel', color: '#1d6f42' },

  env: { name: 'Env', color: '#ECD53F' },
  log: { name: 'Log', color: '#a0a0a0' },
  lock: { name: 'Lockfile', color: '#a0a0a0' },
};

const FILENAME_MAP: Record<string, LanguageMeta> = {
  dockerfile: { name: 'Docker', color: '#384d54' },
  makefile: { name: 'Makefile', color: '#427819' },
  rakefile: { name: 'Ruby', color: '#701516' },
  gemfile: { name: 'Ruby', color: '#701516' },
  procfile: { name: 'Procfile', color: '#a0a0a0' },
};

const OTHER: LanguageMeta = { name: 'Other', color: '#94a3b8' };

export function detectLanguage(filename: string): LanguageMeta {
  const lower = filename.toLowerCase();
  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return OTHER;
  const ext = lower.slice(dot + 1);
  return EXT_MAP[ext] ?? OTHER;
}

export type LanguageBucket = LanguageMeta & { count: number; pct: number };

export function bucketLanguages(filenames: string[]): LanguageBucket[] {
  if (filenames.length === 0) return [];
  const counts = new Map<string, { meta: LanguageMeta; count: number }>();
  for (const f of filenames) {
    const meta = detectLanguage(f);
    const key = meta.name;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { meta, count: 1 });
  }
  const total = filenames.length;
  const list: LanguageBucket[] = [];
  for (const { meta, count } of counts.values()) {
    list.push({ ...meta, count, pct: (count / total) * 100 });
  }
  list.sort((a, b) => b.count - a.count);
  return list;
}
