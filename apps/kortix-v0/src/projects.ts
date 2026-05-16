import { randomUUID } from "node:crypto";
import { getProject, insertProject, listProjects } from "./db";
import { createManagedStarterRepo, detectDefaultBranch, initializeStarterRepo, listRepoFiles, readRepoFile, refreshMirror, repoInspectId } from "./git";
import { warmDaytonaRuntimeSnapshot } from "./providers/daytona";
import type { AgentSummary, EnvRequirements, FileEntry, Project, ProjectConfig, SkillSummary } from "./types";

export interface CreateProjectInput {
  name?: string;
  repoUrl?: string;
  initialize?: boolean;
  managed?: boolean;
}

export interface ProjectDetail {
  project: Project;
  config: ProjectConfig;
  fileCount: number;
}

export interface RepoInspection {
  repoUrl: string;
  defaultBranch: string;
  isKortixRepo: boolean;
  config: ProjectConfig;
  fileCount: number;
  files: FileEntry[];
}

function nameFromRepoUrl(repoUrl: string): string {
  return repoUrl
    .split(/[/:]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/, "")
    || "repo";
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

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const matches = Array.from(inner.matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g));
    return matches
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
      .filter(Boolean);
  }
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envRequirements(manifest: Record<string, unknown>): EnvRequirements {
  const env = typeof manifest.env === "object" && manifest.env ? manifest.env as Record<string, unknown> : {};
  return {
    required: asStringArray(env.required),
    optional: asStringArray(env.optional),
  };
}

async function optionalFile(project: Project, path: string): Promise<string | null> {
  try {
    return await readRepoFile(project, project.defaultBranch, path);
  } catch {
    return null;
  }
}

function parseJsonCString(raw: string | null, key: string): string | null {
  if (!raw) return null;
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

function parseFrontmatter(raw: string | null): Record<string, string> {
  if (!raw?.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

function agentNameFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") || path;
}

async function loadAgents(project: Project, files: FileEntry[]): Promise<AgentSummary[]> {
  const agentFiles = files
    .map((file) => file.path)
    .filter((path) => /^\.opencode\/agents?\/[^/]+\.md$/.test(path))
    .sort();
  return Promise.all(agentFiles.map(async (path) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || meta.slug || agentNameFromPath(path),
      path,
      description: meta.description || null,
      mode: meta.mode || null,
    };
  }));
}

function loadSkills(files: FileEntry[]): SkillSummary[] {
  const seen = new Set<string>();
  const skills: SkillSummary[] = [];
  for (const file of files) {
    const match = file.path.match(/^\.opencode\/skills\/(.+)\/SKILL\.md$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    skills.push({ name: match[1], path: file.path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function transientProjectForRepo(repoUrlInput: unknown, refInput?: unknown): Promise<Project> {
  if (typeof repoUrlInput !== "string" || !repoUrlInput.trim()) {
    throw new Error("Repo URL is required");
  }
  const repoUrl = repoUrlInput.trim();
  const defaultBranch = typeof refInput === "string" && refInput.trim()
    ? refInput.trim()
    : await detectDefaultBranch(repoUrl);
  return {
    id: repoInspectId(repoUrl),
    name: repoUrl.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "") || "repo",
    repoUrl,
    defaultBranch,
    manifestPath: "kortix.toml",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function loadProjectConfig(project: Project): Promise<ProjectConfig> {
  const [
    manifestRaw,
    openCodeConfig,
    files,
  ] = await Promise.all([
    optionalFile(project, project.manifestPath),
    optionalFile(project, ".opencode/opencode.jsonc"),
    listRepoFiles(project, project.defaultBranch),
  ]);
  const agents = await loadAgents(project, files);
  const skills = loadSkills(files);
  const manifest = parseManifest(manifestRaw);
  const signals = {
    manifest: Boolean(manifestRaw),
    openCodeConfig: Boolean(openCodeConfig),
    openCodeAgent: agents.length > 0,
  };

  return {
    isKortixRepo: Object.values(signals).some(Boolean),
    signals,
    manifestRaw,
    manifest,
    env: envRequirements(manifest),
    openCodeRaw: openCodeConfig,
    openCodeDefaultAgent: parseJsonCString(openCodeConfig, "default_agent"),
    agents,
    skills,
    hasOpenCodeConfig: Boolean(openCodeConfig),
    hasOpenCodeAgent: signals.openCodeAgent,
  };
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const id = randomUUID();
  const wantsManagedRepo = Boolean(input.managed) || !(typeof input.repoUrl === "string" && input.repoUrl.trim());
  const repoUrlInput = typeof input.repoUrl === "string" ? input.repoUrl.trim() : "";
  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : repoUrlInput
      ? nameFromRepoUrl(repoUrlInput)
      : "Kortix Project";

  let repoUrl = repoUrlInput;
  let defaultBranch = "main";

  if (wantsManagedRepo) {
    const managed = await createManagedStarterRepo(id, name, defaultBranch);
    repoUrl = managed.repoUrl;
    defaultBranch = managed.defaultBranch;
  } else {
    defaultBranch = await detectDefaultBranch(repoUrl);

    if (input.initialize) {
      await initializeStarterRepo(repoUrl, name, defaultBranch);
    }
  }

  const project = insertProject({
    id,
    name,
    repoUrl,
    defaultBranch,
    manifestPath: "kortix.toml",
  });
  await refreshMirror(project, true);
  void warmDaytonaRuntimeSnapshot().catch((err) => {
    console.warn(`[kortix-v0] Daytona snapshot warmup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return project;
}

export async function getProjectOrThrow(projectId: string): Promise<Project> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  const project = await getProjectOrThrow(projectId);
  const [config, files] = await Promise.all([
    loadProjectConfig(project),
    listRepoFiles(project, project.defaultBranch),
  ]);
  return { project, config, fileCount: files.length };
}

export async function inspectRepo(repoUrlInput: unknown, refInput?: unknown): Promise<RepoInspection> {
  const project = await transientProjectForRepo(repoUrlInput, refInput);
  const [config, files] = await Promise.all([
    loadProjectConfig(project),
    listRepoFiles(project, project.defaultBranch),
  ]);
  return {
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    isKortixRepo: config.isKortixRepo,
    config,
    fileCount: files.length,
    files: files.slice(0, 200),
  };
}

export async function readRepoUrlFile(repoUrlInput: unknown, pathInput: unknown, refInput?: unknown): Promise<{
  repoUrl: string;
  ref: string;
  path: string;
  content: string;
}> {
  if (typeof pathInput !== "string" || !pathInput.trim()) {
    throw new Error("File path is required");
  }
  const project = await transientProjectForRepo(repoUrlInput, refInput);
  return {
    repoUrl: project.repoUrl,
    ref: project.defaultBranch,
    path: pathInput.trim(),
    content: await readRepoFile(project, project.defaultBranch, pathInput.trim()),
  };
}

export function allProjects(): Project[] {
  return listProjects();
}
