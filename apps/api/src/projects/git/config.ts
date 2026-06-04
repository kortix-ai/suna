// Project config introspection: parses kortix.toml + the OpenCode config dir
// (agents/skills/commands) out of the repo into a ProjectConfigSummary.

import { readRepoFile, listRepoFiles } from './files';
import type { GitBackedProject, ProjectConfigSummary, ProjectFileEntry } from './types';

async function optionalFile(project: GitBackedProject, filePath: string) {
  try {
    return await readRepoFile(project, filePath, project.defaultBranch);
  } catch {
    return null;
  }
}

function stripTomlComment(line: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return Array.from(inner.matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g))
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter(Boolean);
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseManifest(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  let section: Record<string, unknown> = out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    const sectionMatch = trimmed.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (sectionMatch) {
      const next: Record<string, unknown> = {};
      out[sectionMatch[1]] = next;
      section = next;
      continue;
    }
    const kv = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    section[kv[1]] = parseTomlValue(kv[2].trim());
  }
  return out;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envRequirements(manifest: Record<string, unknown>) {
  const env = typeof manifest.env === 'object' && manifest.env ? manifest.env as Record<string, unknown> : {};
  return {
    required: asStringArray(env.required),
    optional: asStringArray(env.optional),
  };
}

function parseJsonCString(raw: string | null, key: string) {
  if (!raw) return null;
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

function parseFrontmatter(raw: string | null) {
  if (!raw?.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function agentNameFromPath(path: string) {
  return path.split('/').pop()?.replace(/\.md$/, '') || path;
}

export async function loadProjectConfig(project: GitBackedProject, files?: ProjectFileEntry[]): Promise<ProjectConfigSummary> {
  const repoFiles = files ?? await listRepoFiles(project, project.defaultBranch);
  const manifestRaw = await optionalFile(project, project.manifestPath);
  const manifest = parseManifest(manifestRaw);
  const opencodeDir = resolveOpencodeDir(manifest);
  // Where opencode.jsonc lives. Path comes from the manifest's
  // [opencode] config_dir, defaulting to `.kortix/opencode`.
  const openCodeRaw = await optionalFile(project, `${opencodeDir}/opencode.jsonc`);

  // Build matchers off the configured opencode dir. The trailing
  // `s?` on agents/commands is opencode's own historical quirk (it
  // accepts both `agent/` and `agents/`); we follow suit.
  const escapedDir = escapeRegExp(opencodeDir);
  const agentRe = new RegExp(`^${escapedDir}/agents?/[^/]+\\.md$`);
  const skillRe = new RegExp(`^${escapedDir}/skills/(.+)/SKILL\\.md$`);
  const commandRe = new RegExp(`^${escapedDir}/commands?/([^/]+)\\.md$`);

  const agentPaths = repoFiles
    .map((file) => file.path)
    .filter((path) => agentRe.test(path))
    .sort();
  const agents = await Promise.all(agentPaths.map(async (path) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || meta.slug || agentNameFromPath(path),
      path,
      description: meta.description || null,
      mode: meta.mode || null,
    };
  }));

  const seenSkills = new Set<string>();
  const skillPaths = repoFiles
    .map((file) => file.path.match(skillRe))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => {
      if (seenSkills.has(match[1])) return false;
      seenSkills.add(match[1]);
      return true;
    })
    .map((match) => ({ slug: match[1], path: `${opencodeDir}/skills/${match[1]}/SKILL.md` }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const skills = await Promise.all(skillPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  // OpenCode slash commands — `<opencode>/command/<slug>.md` or
  // `<opencode>/commands/<slug>.md` (both forms accepted by the runtime; we
  // include either if present). Frontmatter `description:` is what gets
  // surfaced in the command picker.
  const commandPaths = repoFiles
    .map((file) => file.path.match(commandRe))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ slug: match[1], path: match.input as string }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const commands = await Promise.all(commandPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  const signals = {
    manifest: Boolean(manifestRaw),
    openCodeConfig: Boolean(openCodeRaw),
    openCodeAgent: agents.length > 0,
  };

  return {
    is_kortix_repo: Object.values(signals).some(Boolean),
    signals,
    manifest_raw: manifestRaw,
    manifest,
    env: envRequirements(manifest),
    open_code_raw: openCodeRaw,
    open_code_default_agent: parseJsonCString(openCodeRaw, 'default_agent'),
    agents,
    skills,
    commands,
  };
}

/**
 * Resolve `[opencode] config_dir` from the parsed manifest. Mirrors the
 * default from triggers.ts (DEFAULT_OPENCODE_CONFIG_DIR) but kept local
 * to avoid a circular import — git.ts is depended on by triggers.ts.
 */
function resolveOpencodeDir(manifest: Record<string, unknown>): string {
  const opencode = manifest.opencode;
  if (opencode && typeof opencode === 'object' && !Array.isArray(opencode)) {
    const raw = (opencode as Record<string, unknown>).config_dir;
    if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      // Reject absolute paths + `..` segments here too. parseManifestString
      // already validates the same on the trigger path; this is a
      // belt-and-suspenders since loadProjectConfig uses its own parser.
      if (!trimmed.startsWith('/') && !trimmed.split('/').includes('..')) {
        return trimmed.replace(/\/+$/, '');
      }
    }
  }
  return '.kortix/opencode';
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
