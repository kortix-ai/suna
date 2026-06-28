/**
 * `buildRegistry` — turn a Kortix repo into a shadcn-format registry.json.
 *
 * Auto-detects the OpenCode primitives in the repo (skills, agents, commands,
 * tools) and emits one item per primitive, each with `files` carrying a
 * repo-relative `path` and an `@alias` `target` so it reinstalls into the
 * right place in any consuming project.
 *
 * Authors can publish *anything else* — arbitrary files, whole folders, even a
 * full-project bundle — by hand-writing a partial registry in
 * `kortix.registry.json` at the repo root; its items are merged in, and any
 * file `path` that points at a directory is expanded to the files beneath it.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  REGISTRY_SCHEMA_URL,
  type RegistryItem,
  type RegistryItemFile,
  type RegistryJson,
} from './schema';
import {
  parseFrontmatter,
  projectNameFromManifest,
  resolveOpencodeDir,
} from './manifest';
import { buildTarget } from './paths';
import { groupSkillFiles } from './skills';

export interface BuildSource {
  /** All repo-relative POSIX file paths (already ignoring .git/node_modules). */
  listFiles(): string[];
  /** Read a repo-relative file as UTF-8. */
  readFile(path: string): string;
  /** True if a repo-relative path is a directory. */
  isDirectory(path: string): boolean;
}

export interface BuildOptions {
  /** Registry name. Defaults to the kortix.toml project name or "registry". */
  name?: string;
  /** Public homepage of the registry. */
  homepage?: string;
  /** Override the auto-detected source (defaults to a node:fs walk of `root`). */
  source?: BuildSource;
  /** Repo root (when `source` is omitted). Defaults to cwd. */
  root?: string;
}

export interface BuildResult {
  registry: RegistryJson;
  /** Per-detected-type counts, for a friendly CLI summary. */
  counts: Record<string, number>;
}

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.vercel',
  'coverage',
]);

export function nodeFsSource(root: string): BuildSource {
  const abs = (p: string) => join(root, p);
  return {
    isDirectory: (p) => {
      try {
        return statSync(abs(p)).isDirectory();
      } catch {
        return false;
      }
    },
    readFile: (p) => readFileSync(abs(p), 'utf8'),
    listFiles: () => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          if (IGNORE_DIRS.has(entry)) continue;
          const full = join(dir, entry);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'));
        }
      };
      walk(root);
      return out;
    },
  };
}

function readOptional(source: BuildSource, path: string): string | null {
  try {
    return source.readFile(path);
  } catch {
    return null;
  }
}

export function buildRegistry(opts: BuildOptions = {}): BuildResult {
  const root = opts.root ?? process.cwd();
  const source = opts.source ?? nodeFsSource(root);
  const files = source.listFiles();

  const manifestRaw = readOptional(source, 'kortix.toml');
  const configDir = resolveOpencodeDir(manifestRaw);
  const name = opts.name ?? projectNameFromManifest(manifestRaw) ?? 'registry';

  const items: RegistryItem[] = [];
  const seenNames = new Set<string>();
  const counts: Record<string, number> = { skill: 0, agent: 0, command: 0, tool: 0, extra: 0 };

  const add = (item: RegistryItem, kind: string) => {
    if (seenNames.has(item.name)) return;
    seenNames.add(item.name);
    items.push(item);
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  // --- skills: <cd>/skills/**/SKILL.md (the dir holding SKILL.md is the skill)
  for (const sk of groupSkillFiles(files, `${configDir}/skills`)) {
    const meta = parseFrontmatter(readOptional(source, sk.skillMd));
    const defaultProjectInstall =
      meta.defaultProjectInstall === 'true'
        ? true
        : meta.defaultProjectInstall === 'false'
          ? false
          : undefined;
    const defaultProjectInstallOrder = Number(meta.defaultProjectInstallOrder);
    add(
      {
        name: meta.name && /^[a-z0-9][a-z0-9-_.]*$/i.test(meta.name) ? meta.name : sk.name,
        type: 'registry:skill',
        title: meta.name || sk.name,
        description: meta.description || undefined,
        categories: groupCategories(sk.relDir),
        files: sk.files.map((f) => ({
          path: f.path,
          type: 'registry:file',
          target: buildTarget.skill(sk.name, f.rel),
        })),
        meta: {
          source: name,
          primitive: 'skill',
          ...(defaultProjectInstall === undefined ? {} : { defaultProjectInstall }),
          ...(Number.isFinite(defaultProjectInstallOrder) ? { defaultProjectInstallOrder } : {}),
        },
      },
      'skill',
    );
  }

  // --- agents + commands: <cd>/agent(s)/<file>.md, <cd>/command(s)/<file>.md
  collectFlatMd(files, source, configDir, ['agents', 'agent'], 'registry:agent', name, add, 'agent', buildTarget.agent);
  collectFlatMd(files, source, configDir, ['commands', 'command'], 'registry:command', name, add, 'command', buildTarget.command);

  // --- tools: <cd>/tools/<file>.ts
  for (const file of files) {
    const m = file.match(new RegExp(`^${escapeRe(configDir)}/tools/([^/]+)\\.ts$`));
    if (!m) continue;
    add(
      {
        name: m[1],
        type: 'registry:tool',
        title: m[1],
        description: `Custom OpenCode tool: ${m[1]}`,
        files: [{ path: file, type: 'registry:file', target: buildTarget.tool(`${m[1]}.ts`) }],
        meta: { source: name, primitive: 'tool' },
      },
      'tool',
    );
  }

  // --- author-declared extras (arbitrary files / folders / project bundles)
  const extrasRaw = readOptional(source, 'kortix.registry.json');
  if (extrasRaw) {
    const extras = JSON.parse(extrasRaw) as RegistryJson;
    if (opts.homepage === undefined && extras.homepage) opts.homepage = extras.homepage;
    for (const item of extras.items ?? []) {
      add(expandExtraItem(item, source, files), 'extra');
    }
  }

  return {
    registry: {
      $schema: REGISTRY_SCHEMA_URL,
      name,
      homepage: opts.homepage,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    },
    counts,
  };
}

function collectFlatMd(
  files: string[],
  source: BuildSource,
  configDir: string,
  dirs: string[],
  type: RegistryItem['type'],
  registryName: string,
  add: (item: RegistryItem, kind: string) => void,
  kind: string,
  target: (file: string) => string,
): void {
  for (const dir of dirs) {
    const re = new RegExp(`^${escapeRe(configDir)}/${dir}/([^/]+)\\.md$`);
    for (const file of files) {
      const m = file.match(re);
      if (!m) continue;
      const meta = parseFrontmatter(readOptional(source, file));
      add(
        {
          name: m[1],
          type,
          title: meta.name || m[1],
          description: meta.description || undefined,
          files: [{ path: file, type: 'registry:file', target: target(`${m[1]}.md`) }],
          meta: { source: registryName, primitive: kind, mode: meta.mode },
        },
        kind,
      );
    }
  }
}

/** Expand an author-declared item: a file `path` that is a directory becomes
 *  one file entry per file beneath it, preserving the relative target. */
function expandExtraItem(item: RegistryItem, source: BuildSource, files: string[]): RegistryItem {
  const expanded: RegistryItemFile[] = [];
  for (const f of item.files ?? []) {
    if (typeof f.content === 'string') {
      expanded.push(f);
      continue;
    }
    if (source.isDirectory(f.path)) {
      const baseTarget = f.target ?? `~/${f.path}`;
      const children = files.filter((c) => c.startsWith(`${f.path.replace(/\/+$/, '')}/`)).sort();
      for (const child of children) {
        const rel = child.slice(f.path.replace(/\/+$/, '').length + 1);
        expanded.push({
          path: child,
          type: f.type ?? 'registry:file',
          target: `${baseTarget.replace(/\/+$/, '')}/${rel}`,
        });
      }
    } else {
      expanded.push({ ...f, type: f.type ?? 'registry:file', target: f.target ?? `~/${f.path}` });
    }
  }
  return { ...item, files: expanded };
}

function groupCategories(skillPath: string): string[] | undefined {
  const parts = skillPath.split('/');
  if (parts.length < 2) return undefined;
  // e.g. "research/pdf" → category "research"
  return [parts[0].toLowerCase()];
}

function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
