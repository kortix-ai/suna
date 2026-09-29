// Project config introspection: parses the project manifest (kortix.yaml,
// falling back to legacy kortix.toml) + the OpenCode config dir
// (agents/skills/commands) out of the repo into a ProjectConfigSummary.

import {
  type ManifestFormat,
  ManifestImportError,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
} from '@kortix/manifest-schema';
import { type LoadedAgents, extractAgents } from '../agents';
import { resolveManifestVerdict } from '../lib/manifest-verdict';
import { listRepoFiles, readManifestFromRepo, readRepoFile } from './files';
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
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
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
  const env =
    typeof manifest.env === 'object' && manifest.env
      ? (manifest.env as Record<string, unknown>)
      : {};
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

function parseFullManifest(
  raw: string | null,
  format: ManifestFormat,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return parseManifestText(raw, format);
  } catch {
    return null;
  }
}

function hasAgentsDeclaration(raw: string | null): boolean {
  // TOML `[[agents]]` / `[agents]`, OR YAML `agents:`.
  return Boolean(raw && (/^\s*\[\[?agents\]?\]/m.test(raw) || /^\s*agents\s*:/m.test(raw)));
}

/** Tolerant `kortix_version` read for a raw parsed manifest object — mirrors
 *  `parseManifestString` in `../triggers.ts` (defaults to 1 when absent, the
 *  same back-compat rule every other manifest reader in this package uses). */
function manifestSchemaVersionFor(parsed: Record<string, unknown>): number {
  const raw = parsed.kortix_version;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return 1;
}

type NativeAgentSummary = Omit<ProjectConfigSummary['agents'][number], 'source' | 'enabled'>;

export function resolveConfigAgents(
  nativeAgents: NativeAgentSummary[],
  loadedAgents: LoadedAgents,
): Pick<ProjectConfigSummary, 'agent_discovery' | 'agents'> {
  if (loadedAgents.specs.length === 0 && loadedAgents.errors.length === 0) {
    return {
      agent_discovery: 'opencode',
      agents: nativeAgents.map((agent) => ({
        ...agent,
        source: 'opencode' as const,
        enabled: true,
      })),
    };
  }

  const nativeByName = new Map(nativeAgents.map((agent) => [agent.name, agent]));
  const nativeByPath = new Map(nativeAgents.map((agent) => [agent.path, agent]));
  return {
    agent_discovery: 'declarative',
    agents: loadedAgents.specs
      .filter((spec) => spec.enabled)
      .map((spec) => {
        const native =
          (spec.file ? nativeByPath.get(spec.file) : undefined) ?? nativeByName.get(spec.name);
        return {
          name: spec.name,
          path: spec.file ?? native?.path ?? spec.path,
          description: native?.description ?? null,
          mode: native?.mode ?? null,
          model: native?.model ?? null,
          source: 'kortix.yaml' as const,
          enabled: spec.enabled,
          sandbox: spec.sandbox ?? null,
          // Surface the per-agent allowlists so the UI can show (read-only) what
          // secrets/connectors/Kortix permissions each declared agent is scoped to.
          // `kortix_cli` is the deprecated wire alias of `kortix_permissions`,
          // kept so clients released before the rename still read it.
          scope: {
            env: spec.env,
            connectors: spec.connectors,
            kortix_permissions: spec.permissions,
            kortix_cli: spec.permissions,
            // Kortix Apps this agent may open when restricted/private (§2.5).
            apps: spec.apps ?? [],
          },
        };
      }),
  };
}

type ResourceMatch = { key: string; path: string };

/**
 * Resolve the project manifest (dual-format, import-tolerant) and interpret
 * its agents declaration. Everything manifest-derived the summary needs
 * comes back in one object.
 */
async function resolveProjectManifest(project: GitBackedProject) {
  // Dual-format: resolve kortix.yaml (preferred) or kortix.toml, then parse in
  // the matched format. Without this, a yaml-only project reads no manifest here
  // → its [[agents]] scoping silently vanishes from the config introspection.
  const candidatePaths = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
  const resolved = await readManifestFromRepo(project, candidatePaths, project.defaultBranch)
    // A broken `imports:` must not make the summary report "no manifest" (the
    // UI would offer to create one). Degrade to the root file alone; the
    // Triggers page surfaces the import error itself.
    .catch((err) =>
      err instanceof ManifestImportError
        ? readManifestFromRepo(project, candidatePaths, project.defaultBranch, {
            resolveImports: false,
          })
        : null,
    )
    .catch(() => null);
  const manifestRaw = resolved?.content ?? null;
  const manifestFormat: ManifestFormat = resolved ? manifestFormatForPath(resolved.path) : 'toml';
  const manifestFilePath = resolved?.path ?? project.manifestPath;
  const parsedManifest = parseFullManifest(manifestRaw, manifestFormat);
  const manifest = parsedManifest ?? parseManifest(manifestRaw);
  const loadedAgents = parsedManifest
    ? extractAgents({
        // `extractAgents` dispatches its `[[agents]]` (v1 array) vs `agents:`
        // (v2 map) reader on THIS field — it must reflect the manifest's own
        // declared `kortix_version`, not a hardcoded v1, or a v2 project's
        // config summary would misreport its map-shaped `agents` as an
        // invalid v1 array.
        schemaVersion: manifestSchemaVersionFor(parsedManifest),
        raw: parsedManifest,
        format: manifestFormat,
        path: manifestFilePath,
      })
    : hasAgentsDeclaration(manifestRaw)
      ? {
          specs: [],
          errors: [
            {
              name: '(manifest)',
              path: manifestFilePath,
              error: 'Failed to parse agents declaration',
            },
          ],
        }
      : { specs: [], errors: [] };
  return { resolved, manifestRaw, manifestFormat, manifest, loadedAgents };
}

export async function loadProjectConfig(
  project: GitBackedProject,
  files?: ProjectFileEntry[],
): Promise<ProjectConfigSummary> {
  const repoFiles = files ?? (await listRepoFiles(project, project.defaultBranch));
  const resolution = await resolveProjectManifest(project);
  const { manifest, loadedAgents } = resolution;
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

  const nativeAgents = await scanOpenCodeResources(
    project,
    repoFiles,
    // Omitting `compare` keeps the plain path order of Array.prototype.sort.
    (path) => (agentRe.test(path) ? { key: path, path } : null),
    undefined,
    (key, path, meta) => ({
      name: meta.name || meta.slug || agentNameFromPath(path),
      path,
      description: meta.description || null,
      mode: meta.mode || null,
      model: meta.model || null,
    }),
  );
  const { agent_discovery, agents } = resolveConfigAgents(nativeAgents, loadedAgents);

  const seenSkills = new Set<string>();
  const skills = await scanOpenCodeResources(
    project,
    repoFiles,
    (path) => {
      const match = path.match(skillRe);
      if (!match || seenSkills.has(match[1])) return null;
      seenSkills.add(match[1]);
      return { key: match[1], path: `${opencodeDir}/skills/${match[1]}/SKILL.md` };
    },
    (a, b) => a.key.localeCompare(b.key),
    (key, path, meta) => ({ name: meta.name || key, path, description: meta.description || null }),
  );

  // OpenCode slash commands — `<opencode>/command/<slug>.md` or
  // `<opencode>/commands/<slug>.md` (both forms accepted by the runtime; we
  // include either if present). Frontmatter `description:` is what gets
  // surfaced in the command picker.
  const commands = await scanOpenCodeResources(
    project,
    repoFiles,
    (path) => {
      const match = path.match(commandRe);
      return match ? { key: match[1], path: match.input as string } : null;
    },
    (a, b) => a.key.localeCompare(b.key),
    (key, path, meta) => ({ name: meta.name || key, path, description: meta.description || null }),
  );

  return buildProjectConfigSummary(resolution, openCodeRaw, {
    agent_discovery,
    agents,
    skills,
    commands,
  });
}

/**
 * One discovery pipeline over the repo files: match every path, sort the
 * matches, then load each matched file and build its entry. `key` is the
 * sort key; `meta` is the matched file's parsed frontmatter ({} when the
 * file has none). A matcher returning null skips a path; the skills'
 * slug-dedupe lives in its own matcher. Omit `compare` for the plain path
 * order of `Array.prototype.sort` (agents); pass a locale-aware comparator
 * for slug order (skills/commands).
 */
async function scanOpenCodeResources<T>(
  project: GitBackedProject,
  repoFiles: ProjectFileEntry[],
  matcher: (path: string) => ResourceMatch | null,
  compare: ((a: ResourceMatch, b: ResourceMatch) => number) | undefined,
  buildEntry: (key: string, path: string, meta: Record<string, string>) => T,
): Promise<T[]> {
  return Promise.all(
    repoFiles
      .map((file) => matcher(file.path))
      .filter((match): match is ResourceMatch => Boolean(match))
      .sort(compare)
      .map(async ({ key, path }) => {
        const raw = await optionalFile(project, path);
        const meta = parseFrontmatter(raw);
        return buildEntry(key, path, meta);
      }),
  );
}

/**
 * Assemble the ProjectConfigSummary from the resolved manifest, the OpenCode
 * config read and the three resource scans.
 */
function buildProjectConfigSummary(
  resolution: Awaited<ReturnType<typeof resolveProjectManifest>>,
  openCodeRaw: string | null,
  discovery: Pick<ProjectConfigSummary, 'agent_discovery' | 'agents' | 'skills' | 'commands'>,
): ProjectConfigSummary {
  const { resolved, manifestRaw, manifestFormat, manifest, loadedAgents } = resolution;
  const { agent_discovery, agents, skills, commands } = discovery;
  const signals = {
    manifest: Boolean(manifestRaw),
    openCodeConfig: Boolean(openCodeRaw),
    openCodeAgent: agents.length > 0,
  };

  return {
    is_kortix_repo: Object.values(signals).some(Boolean),
    signals,
    // The root file's own text. `manifest`/`env`/agents below come from the
    // merged document when the root declares `imports:`.
    manifest_raw: resolved?.rootContent ?? manifestRaw,
    manifest,
    // The authoritative version verdict. Computed here so no client ever has to
    // infer a version from the raw text — and so an unreadable manifest reports
    // `unknown` instead of being mistaken for a legacy v1.
    manifest_version: resolveManifestVerdict({
      raw: manifestRaw,
      format: manifestFormat,
      path: resolved?.path ?? null,
    }),
    env: envRequirements(manifest),
    open_code_raw: openCodeRaw,
    // v2 makes the manifest's declared default authoritative. Legacy projects
    // keep reading OpenCode's native default_agent for backwards compatibility.
    open_code_default_agent:
      loadedAgents.defaultAgent ?? parseJsonCString(openCodeRaw, 'default_agent'),
    agent_discovery,
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
