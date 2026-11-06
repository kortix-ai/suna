// Project config introspection: parses the project manifest (kortix.yaml) out
// of the repo into a ProjectConfigSummary. kortix.yaml is the only source:
// agents are its blocks, skills its `skills` registry plus the Kortix skills,
// commands its `commands` registry. A folder or file the manifest does not
// register is never listed.

import {
  legacyFormatMessage,
  locateIssues,
  ManifestImportError,
  type ManifestIssue,
  MANIFEST_SYNTAX_ISSUE_PATH,
  isManifestSyntaxError,
  manifestCandidatePaths,
  parseManifestText,
  SKILLS_DIR,
  SPACE_HEADER_ITEMS,
  SPACE_TAB_TYPES,
  type SpaceBlockV3,
  type SpaceHeaderItem,
  type SpaceTabV3,
  deprecationIssues,
  validateManifest,
} from '@kortix/manifest-schema';
import { type LoadedAgents, extractAgents } from '../agents';
import { parse as parseYaml } from 'yaml';
import { listManagedSkills } from '../../skills/catalog';
import { readManifest, runtimeManifest } from '../manifest-io';
import { type FileManifestIssue, type ManifestHealth, manifestHealthOf, manifestHealthWithout } from '../lib/manifest-health';
import { isRepoFileNotFoundError, listRepoFiles, prefetchRepoFiles, readManifestFromRepo, readRepoFile } from './files';
import type { GitBackedProject, ProjectConfigSummary, ProjectFileEntry } from './types';

/** A strict read (a saved summary build) rethrows every error except "not in this commit". */
async function optionalFile(project: GitBackedProject, filePath: string, ref = project.defaultBranch, strict = false) {
  try {
    return await readRepoFile(project, filePath, ref);
  } catch (err) {
    if (strict && !isRepoFileNotFoundError(err)) throw err;
    return null;
  }
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

/** A file's frontmatter, every scalar as text. The YAML parser reads what a
 *  YAML writer emits, including a long scalar folded over several lines (the
 *  agent editor's `stringifyYaml`). A block the parser refuses falls back to
 *  the one-line reader below, so a hand-written, not-quite-YAML header still
 *  yields its simple keys. */
function parseFrontmatter(raw: string | null): Record<string, string> {
  if (!raw?.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  try {
    const parsed: unknown = parseYaml(raw.slice(3, end));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const meta: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          meta[key] = String(value);
        }
      }
      return meta;
    }
  } catch {
    // Not valid YAML: read it line by line below.
  }
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = frontmatterScalar(match[2]);
  }
  return meta;
}

/** Read one scalar the way a YAML writer may have serialized it. A
 *  double-quoted scalar carries escapes (a writer like `stringifyYaml` emits
 *  one whenever the text needs quoting); strip the quotes and unescape its
 *  two escapes. Single-quoted and plain scalars carry no backslash escapes:
 *  unwrap a matched quote pair, and leave a lone quote character — a plain
 *  scalar may end in one (`Deploy "v1"`) — exactly where it is. */
function frontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

type NativeAgentSummary = Omit<ProjectConfigSummary['agents'][number], 'source' | 'enabled'>;

export function resolveConfigAgents(
  nativeAgents: NativeAgentSummary[],
  loadedAgents: LoadedAgents,
  /** The declared agent's prompt file, when it has one. */
  resolveFile: (spec: LoadedAgents['specs'][number]) => string | undefined = () => undefined,
): Pick<ProjectConfigSummary, 'agent_discovery' | 'agents'> {
  const nativeByName = new Map(nativeAgents.map((agent) => [agent.name, agent]));
  const nativeByPath = new Map(nativeAgents.map((agent) => [agent.path, agent]));
  return {
    agent_discovery: 'declarative',
    // The FULL registered roster: a disabled agent stays listed with
    // `enabled: false` (the SDK pickers' `isSelectableAgent` and the web agents
    // page's disabled badge already filter it at their own layer). Dropping it
    // here made GET agents answer a subset of what the manifest registers.
    agents: loadedAgents.specs
      .map((spec) => {
        const file = resolveFile(spec);
        const native = (file ? nativeByPath.get(file) : undefined) ?? nativeByName.get(spec.name);
        return {
          name: spec.name,
          path: file ?? native?.path ?? spec.path,
          description: native?.description ?? null,
          mode: native?.mode ?? null,
          ...(native?.hidden === true ? { hidden: true } : {}),
          model: native?.model ?? null,
          space: native?.space ?? null,
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

/**
 * The config of a project whose repository cannot be reached: nothing was
 * read, and `manifest_health.state` says why instead of `unreadable`
 * (KRTX-2955).
 */
export function disconnectedProjectConfig(): ProjectConfigSummary {
  return {
    is_kortix_repo: false,
    signals: { manifest: false, declaredAgents: false },
    manifest_raw: null,
    manifest: {},
    manifest_health: manifestHealthWithout('repository_disconnected'),
    env: { required: [], optional: [] },
    default_agent: null,
    agent_discovery: 'declarative',
    agents: [],
    skills: [],
    commands: [],
  };
}

type ManifestRead = Awaited<ReturnType<typeof readManifestFromRepo>>;

/**
 * The manifest at the default branch, imports resolved the way the runtime
 * resolves them. A broken `imports:` degrades to the root file alone and
 * becomes an `imports` error: the summary must not report "no manifest" (the
 * UI would offer to create one). `failed`: the repository read itself failed.
 */
async function readProjectManifest(
  project: GitBackedProject,
  ref = project.defaultBranch,
  strict = false,
): Promise<{ found: ManifestRead; importError: ManifestIssue | null; failed: boolean }> {
  const candidates = manifestCandidatePaths(project.manifestPath);
  let importError: ManifestIssue | null = null;
  try {
    const found = await readManifestFromRepo(project, candidates, ref).catch((err) => {
      if (!(err instanceof ManifestImportError)) throw err;
      importError = { path: 'imports', message: err.message, severity: 'error' };
      return readManifestFromRepo(project, candidates, ref, { resolveImports: false });
    });
    return { found, importError, failed: false };
  } catch (err) {
    // A saved summary must never record a failed read as the commit's config.
    if (strict) throw err;
    return { found: null, importError: null, failed: true };
  }
}

/**
 * `manifest_health` of what `readProjectManifest` read. A legacy file
 * (`kortix_version` 1 or 2, or `kortix.toml`) is read converted: one warning
 * that it still works and `--fix` converts it, one per thing the conversion
 * could not carry over, and the issues of the converted manifest. A YAML
 * manifest beside a leftover `kortix.toml` warns that the TOML is not read.
 */
function projectManifestHealth(
  read: Awaited<ReturnType<typeof readProjectManifest>>,
  repoPaths: ReadonlySet<string>,
  manifestPath: string,
): ManifestHealth {
  if (read.failed) return manifestHealthWithout('unreadable');
  if (!read.found) return manifestHealthWithout('missing');
  const found = read.found;
  if (found.legacy) {
    const { legacy } = found;
    const versionLine = found.rootContent.split('\n').findIndex((line) => /^kortix_version\s*[:=]/.test(line));
    const converted = legacy.error ? [] : validateManifest(parseManifestText(found.content)).issues;
    // A YAML file keeps most of its keys: an issue points at the nearest one.
    if (legacy.from === 2) locateIssues(found.rootContent, converted);
    const issues: FileManifestIssue[] = [
      {
        path: 'kortix_version',
        message: legacyFormatMessage(legacy.from),
        severity: 'warning',
        fix: 'legacy-format',
        ...(versionLine >= 0 ? { line: versionLine + 1, column: 1 } : {}),
      },
      ...(legacy.error ? [{ path: '<toml>', message: `Syntax error: ${legacy.error}. No agent runs until it is fixed.`, severity: 'error' as const }] : []),
      ...legacy.dropped.map((note) => ({ path: 'kortix_version', message: `Not carried over: ${note}`, severity: 'warning' as const, fix: 'legacy-format', ...(versionLine >= 0 ? { line: versionLine + 1, column: 1 } : {}) })),
      ...converted,
    ];
    return manifestHealthOf(found.path, read.importError ? [read.importError, ...issues] : issues);
  }
  const leftoverToml = manifestCandidatePaths(manifestPath)[0]!.replace(/\.ya?ml$/, '.toml');
  const tomlNote: FileManifestIssue[] = found.path.endsWith('.toml') || !repoPaths.has(leftoverToml)
    ? []
    : [{ path: leftoverToml, message: `${leftoverToml} is no longer read: ${found.path} is the manifest. Delete it.`, severity: 'warning', file: leftoverToml }];
  if (!found.imports) {
    const { issues } = validateManifest(found.content);
    return manifestHealthOf(found.path, [...(read.importError ? [read.importError] : []), ...issues, ...tomlNote]);
  }
  // A merged `imports:` document is already in the latest shape and has no lines:
  // each file reports its own deprecated shapes, at its own lines.
  const deprecated = found.imports.files.flatMap((file) => {
    const text = file.path === found.path ? found.content : file.text;
    return text ? deprecationIssues(text).map((issue) => (file.path === found.path ? issue : { ...issue, file: file.path })) : [];
  });
  const { issues } = validateManifest(found.imports.raw);
  return manifestHealthOf(found.path, [...(read.importError ? [read.importError] : []), ...issues, ...deprecated, ...tomlNote]);
}

function manifestMap(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function manifestText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The top-level `spaces:` map as a sorted array. A tab or block of an unknown
 *  type is dropped, so a manifest mid-edit never breaks the listing. Empty when
 *  none are declared. */
function spacesFromManifest(manifest: Record<string, unknown>): NonNullable<ProjectConfigSummary['spaces']> {
  const text = (value: unknown) => manifestText(value)?.trim() || undefined;
  const BLOCK_TYPES: readonly string[] = ['chat', 'artifact', 'app', 'iframe', 'text'];
  const block = (b: Record<string, unknown>): SpaceBlockV3 => ({
    type: b.type as SpaceBlockV3['type'],
    label: text(b.label),
    room: text(b.room),
    path: text(b.path),
    app: text(b.app),
    url: text(b.url),
    text: manifestText(b.text) ?? undefined,
  });
  const tab = (t: Record<string, unknown>): SpaceTabV3 => ({
    type: t.type as SpaceTabV3['type'],
    label: text(t.label),
    path: text(t.path),
    app: text(t.app),
    artifact: text(t.artifact),
    url: text(t.url),
    ...(typeof t.embed === 'boolean' ? { embed: t.embed } : {}),
    ...(Array.isArray(t.blocks)
      ? { blocks: t.blocks.map(manifestMap).filter((b) => BLOCK_TYPES.includes(b.type as string)).map(block) }
      : {}),
  });
  return Object.entries(manifestMap(manifest.spaces))
    .map(([name, meta]) => {
      const m = manifestMap(meta);
      const header = Array.isArray(m.header)
        ? m.header.filter((item): item is SpaceHeaderItem => (SPACE_HEADER_ITEMS as readonly unknown[]).includes(item))
        : undefined;
      const tabs = Array.isArray(m.tabs)
        ? m.tabs.map(manifestMap).filter((t) => (SPACE_TAB_TYPES as readonly unknown[]).includes(t.type)).map(tab)
        : undefined;
      return {
        name,
        label: text(m.label),
        description: text(m.description),
        order: typeof m.order === 'number' ? m.order : undefined,
        ...(header ? { header } : {}),
        ...(tabs ? { tabs } : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The syntax-error issue, with what the project runs until the file is fixed:
 * the last commit's file that parses, or (none) only My Kortix.
 */
function withSyntaxErrorConsequence(health: ManifestHealth, lastGoodCommit: string | null): ManifestHealth {
  const consequence = lastGoodCommit
    ? ` Kortix keeps running this file as of commit ${lastGoodCommit.slice(0, 7)}, the last version that parses, until it is fixed. Edits from Kortix are refused until then.`
    : ' No earlier version parses, so only My Kortix runs until it is fixed.';
  return {
    ...health,
    issues: health.issues.map((issue) =>
      issue.path === MANIFEST_SYNTAX_ISSUE_PATH ? { ...issue, message: `${issue.message.trimEnd()}${consequence}` } : issue,
    ),
  };
}

/** The project config summary at the default branch, with the Kortix skills. */
export async function loadProjectConfig(
  project: GitBackedProject,
  files?: ProjectFileEntry[],
): Promise<ProjectConfigSummary> {
  return withKortixSkills(await loadRepoConfigSummary(project, files));
}

/**
 * The config summary of the repository alone, at `ref` (a commit pins every
 * read to it): `loadProjectConfig` without the Kortix skills, which change
 * with the API, not with the repository. The saved summaries
 * (`projects/config-summary/`) store this. `files` must be the listing at the
 * same `ref`.
 */
export async function loadRepoConfigSummary(
  project: GitBackedProject,
  files?: ProjectFileEntry[],
  ref = project.defaultBranch,
  opts: { strict?: boolean } = {},
): Promise<ProjectConfigSummary> {
  // `strict`: a saved summary is kept until the next commit, so a read that
  // failed (a fetch timeout, a byte limit) throws instead of reading as
  // "no manifest" or "no description". The build fails and keeps the last row.
  const strict = opts.strict === true;
  const [repoFiles, read] = await Promise.all([
    files ?? listRepoFiles(project, ref),
    readProjectManifest(project, ref, strict),
  ]);
  const repoPaths = new Set(repoFiles.map((file) => file.path));
  let health = projectManifestHealth(read, repoPaths, project.manifestPath);
  const { found } = read;
  let manifest: Record<string, unknown> = {};
  let source: string | null = found && !found.imports ? found.content : null;
  let imports = found?.imports;
  try {
    if (found) manifest = found.imports?.raw ?? parseManifestText(found.content);
  } catch (err) {
    // Not YAML: the project runs the last commit's file that is
    // (`readManifest`), and with none only My Kortix. `manifest_health` names
    // the error and says which of the two applies.
    if (!isManifestSyntaxError(err)) throw err;
    const lastGood = strict ? await readManifest(project, { rethrowReadErrors: true }) : await readManifest(project).catch(() => null);
    if (lastGood?.fallback) {
      manifest = lastGood.raw;
      source = lastGood.imports ? null : (lastGood.source ?? null);
      imports = lastGood.imports;
    } else {
      source = null;
    }
    health = withSyntaxErrorConsequence(health, lastGood?.fallback?.commit ?? null);
  }
  // The roster a running project applies: an agent with an error is listed off.
  const loadedAgents = extractAgents(
    runtimeManifest({
      raw: manifest,
      path: found?.path ?? project.manifestPath,
      // The import origins: an agent declared in an imported file is attributed to that file.
      imports,
      source,
    }),
  );

  const map = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const blocks = map(manifest.agents);
  const natives: NativeAgentSummary[] = loadedAgents.specs.map((spec) => {
    const block = map(blocks[spec.name]);
    return {
      name: spec.name,
      path: text(block.prompt_file) ?? spec.path,
      description: text(block.description),
      mode: text(block.mode),
      ...(block.hidden === true ? { hidden: true } : {}),
      model: text(block.model),
      space: text(block.space),
    };
  });
  const { agents } = resolveConfigAgents(natives, loadedAgents, (spec) => text(map(blocks[spec.name]).prompt_file) ?? undefined);

  const skillEntries = Object.entries(map(manifest.skills)).map(([name, folder]) => ({ name, path: `${String(folder)}/SKILL.md` }));
  // One fetch for every SKILL.md, not one per skill (`prefetchRepoFiles`).
  await prefetchRepoFiles(project, skillEntries.map(({ path }) => path).filter((path) => repoPaths.has(path)), ref);
  const projectSkills = await Promise.all(
    skillEntries.map(async ({ name, path }) => {
      const meta = repoPaths.has(path) ? parseFrontmatter(await optionalFile(project, path, ref, strict)) : {};
      return { name, path, description: meta.description || null };
    }),
  );

  const manifestPath = found?.path ?? project.manifestPath ?? 'kortix.yaml';
  const commands = Object.entries(map(manifest.commands))
    .map(([name, entry]) => ({
      name,
      path: text(map(entry).prompt_file) ?? `${manifestPath}#commands.${name}`,
      description: text(map(entry).description),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    is_kortix_repo: Boolean(found),
    signals: { manifest: Boolean(found), declaredAgents: loadedAgents.specs.length > 0 },
    // The root file's own text. `manifest`/`env`/agents come from the merged
    // document when the root declares `imports:`.
    manifest_raw: found?.rootContent ?? null,
    manifest,
    manifest_health: health,
    env: envRequirements(manifest),
    default_agent: loadedAgents.defaultAgent ?? null,
    agent_discovery: 'declarative',
    agents,
    skills: projectSkills,
    commands,
    spaces: spacesFromManifest(manifest),
  };
}

/**
 * The project's skills plus the Kortix skills. kortixd injects the Kortix skills
 * into every session, so every project lists them. A repo copy of the same name
 * (the scaffold's `kortix-cli`) is listed once.
 */
export function withKortixSkills(config: ProjectConfigSummary): ProjectConfigSummary {
  return { ...config, skills: withKortixSkillList(config.skills) };
}

function withKortixSkillList(skills: ProjectConfigSummary['skills']): ProjectConfigSummary['skills'] {
  const names = new Set(skills.map((skill) => skill.name));
  const kortixSkills = listManagedSkills()
    .filter((skill) => !names.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      path: `${SKILLS_DIR}/${skill.name}/SKILL.md`,
      description: skill.description || null,
    }));
  return [...skills, ...kortixSkills].sort((a, b) => a.name.localeCompare(b.name));
}
