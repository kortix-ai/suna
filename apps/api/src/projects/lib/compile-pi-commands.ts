/**
 * Compile project slash commands for the immutable Pi runtime artifact.
 *
 * The I/O entrypoint reads every byte by Git SHA. The worker never scans its
 * environment or follows the project's moving branch at runtime.
 */
import {
  manifestCandidatePaths,
  manifestDefaultConfigDir,
  manifestFormatForPath,
  parseManifestText,
} from '@kortix/manifest-schema';
import {
  type GitBackedProject,
  isRepoFileNotFoundError,
  listRepoFiles,
  readManifestFromRepo,
  readRepoFile,
} from '../git';
import { parseAgentMarkdown } from './agent-markdown';

export interface CompiledPiCommand {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  variant?: string;
  subtask?: boolean;
  source: 'command';
  hints: string[];
}

interface CompilePiCommandsInput {
  configDir: string;
  configRaw: string | null;
  markdownFiles: Record<string, string>;
}

function manifestSchemaVersion(manifest: Record<string, unknown>): number {
  const value = manifest.kortix_version;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return 1;
}

function configDirOf(block: unknown): string | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const value = (block as Record<string, unknown>).config_dir;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\/+$/, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`invalid Pi command config_dir: ${value}`);
  }
  return normalized;
}

export function piCommandConfigDir(manifest: Record<string, unknown>): string {
  return (
    configDirOf(manifest.pi) ??
    configDirOf(manifest.opencode) ??
    manifestDefaultConfigDir(manifestSchemaVersion(manifest))
  );
}

function commandNameFromPath(path: string, configDir: string): string {
  const prefix = path.startsWith(`${configDir}/commands/`)
    ? `${configDir}/commands/`
    : `${configDir}/command/`;
  return path.slice(prefix.length, -'.md'.length);
}

function markdownCommandName(pathName: string, frontmatter: Record<string, unknown>): string {
  if (frontmatter.name === undefined) return pathName;
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
    throw new Error(`Pi command "${pathName}" field "name" must be a non-empty string`);
  }
  return frontmatter.name.trim();
}

function optionalString(
  record: Record<string, unknown>,
  field: 'description' | 'agent' | 'model' | 'variant',
  commandName: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Pi command "${commandName}" field "${field}" must be a string`);
  }
  return value;
}

function commandHints(template: string): string[] {
  const numbered = template.match(/\$\d+/g) ?? [];
  const hints = [...new Set(numbered)].sort();
  if (template.includes('$ARGUMENTS')) hints.push('$ARGUMENTS');
  return hints;
}

function commandFromRecord(
  name: string,
  record: Record<string, unknown>,
  templateOverride?: string,
): CompiledPiCommand {
  const template = templateOverride ?? record.template;
  if (typeof template !== 'string' || !template.trim()) {
    throw new Error(`Pi command "${name}" requires a non-empty template`);
  }
  if (record.subtask !== undefined && typeof record.subtask !== 'boolean') {
    throw new Error(`Pi command "${name}" field "subtask" must be a boolean`);
  }
  const description = optionalString(record, 'description', name);
  const agent = optionalString(record, 'agent', name);
  const model = optionalString(record, 'model', name);
  const variant = optionalString(record, 'variant', name);
  return {
    name,
    template,
    ...(description !== undefined ? { description } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(record.subtask !== undefined ? { subtask: record.subtask } : {}),
    source: 'command',
    hints: commandHints(template),
  };
}

function commandsFromConfig(raw: string | null): Map<string, CompiledPiCommand> {
  const commands = new Map<string, CompiledPiCommand>();
  if (!raw?.trim()) return commands;
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(raw);
  } catch (error) {
    throw new Error(`Pi command config is invalid JSONC: ${String((error as Error).message)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pi command config must be a JSON object');
  }
  const rawCommands = (parsed as Record<string, unknown>).command;
  if (rawCommands === undefined) return commands;
  if (!rawCommands || typeof rawCommands !== 'object' || Array.isArray(rawCommands)) {
    throw new Error('Pi command config field "command" must be an object');
  }
  for (const [name, value] of Object.entries(rawCommands as Record<string, unknown>)) {
    if (!name.trim()) throw new Error('Pi command name must not be empty');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Pi command "${name}" must be an object`);
    }
    commands.set(name, commandFromRecord(name, value as Record<string, unknown>));
  }
  return commands;
}

export function compilePiCommands(input: CompilePiCommandsInput): CompiledPiCommand[] {
  const commands = commandsFromConfig(input.configRaw);
  for (const path of Object.keys(input.markdownFiles).sort()) {
    const pathName = commandNameFromPath(path, input.configDir);
    if (!pathName) throw new Error(`Pi command path "${path}" has no command name`);
    const raw = input.markdownFiles[path];
    if (raw === undefined) throw new Error(`Pi command path "${path}" has no content`);
    const parsed = parseAgentMarkdown(raw);
    const name = markdownCommandName(pathName, parsed.frontmatter);
    commands.set(name, commandFromRecord(name, parsed.frontmatter, parsed.body.trim()));
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function optionalRepoFileAtSha(
  project: GitBackedProject,
  path: string,
  sourceSha: string,
): Promise<string | null> {
  try {
    return await readRepoFile(project, path, sourceSha);
  } catch (error) {
    if (isRepoFileNotFoundError(error)) return null;
    throw error;
  }
}

export async function resolveCompiledPiCommandsForSession(
  project: GitBackedProject,
  sourceSha: string,
): Promise<CompiledPiCommand[]> {
  const manifest = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((candidate) => candidate.path),
    sourceSha,
  );
  const parsedManifest = manifest
    ? (parseManifestText(manifest.content, manifestFormatForPath(manifest.path)) as Record<
        string,
        unknown
      >)
    : {};
  const configDir = piCommandConfigDir(parsedManifest);
  const repoFiles = await listRepoFiles(project, sourceSha);
  const commandPrefix = new RegExp(
    `^${configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/commands?/.+\\.md$`,
  );
  const commandPaths = repoFiles
    .map((file) => file.path)
    .filter((path) => commandPrefix.test(path))
    .sort();
  const markdownFiles: Record<string, string> = {};
  await Promise.all(
    commandPaths.map(async (path) => {
      markdownFiles[path] = await readRepoFile(project, path, sourceSha);
    }),
  );
  const configRaw =
    (await optionalRepoFileAtSha(project, `${configDir}/opencode.jsonc`, sourceSha)) ??
    (await optionalRepoFileAtSha(project, `${configDir}/opencode.json`, sourceSha));
  return compilePiCommands({ configDir, configRaw, markdownFiles });
}
