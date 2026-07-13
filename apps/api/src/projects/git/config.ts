// Project config introspection: parses the project manifest (kortix.yaml,
// falling back to legacy kortix.toml) + the OpenCode config dir
// (agents/skills/commands) out of the repo into a ProjectConfigSummary.

import {
  type ManifestFormat,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
} from "@kortix/manifest-schema";
import { type LoadedAgents, extractAgents } from "../agents";
import { compileRuntimeConfig } from "../lib/compile-runtime-config";
import type { CompiledRuntimeConfig } from "../lib/compile-runtime-config";
import { listRepoFiles, readManifestFromRepo, readRepoFile } from "./files";
import type {
  GitBackedProject,
  ProjectConfigSummary,
  ProjectFileEntry,
} from "./types";

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
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return Array.from(inner.matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g))
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
      .filter(Boolean);
  }
  if (value === "true" || value === "false") return value === "true";
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
    if (typeof item !== "string") continue;
    const key = item.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envRequirements(manifest: Record<string, unknown>) {
  const env =
    typeof manifest.env === "object" && manifest.env
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

function agentNameFromPath(path: string) {
  return path.split("/").pop()?.replace(/\.md$/, "") || path;
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
  return Boolean(
    raw && (/^\s*\[\[?agents\]?\]/m.test(raw) || /^\s*agents\s*:/m.test(raw)),
  );
}

/** Tolerant `kortix_version` read for a raw parsed manifest object — mirrors
 *  `parseManifestString` in `../triggers.ts` (defaults to 1 when absent, the
 *  same back-compat rule every other manifest reader in this package uses). */
function manifestSchemaVersionFor(parsed: Record<string, unknown>): number {
  const raw = parsed.kortix_version;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return 1;
}

type NativeAgentSummary = Omit<
  ProjectConfigSummary["agents"][number],
  "source" | "enabled"
>;

type RuntimeFileDiscovery = {
  configs: Array<{
    runtime: string;
    harness: "claude" | "codex" | "opencode" | "pi";
    configDir: string;
    path: string;
  }>;
  agents: Array<{
    runtime: string;
    harness: "claude" | "codex" | "opencode" | "pi";
    nativeName: string;
    path: string;
  }>;
  skills: Array<{
    runtime: string;
    harness: "claude" | "codex" | "opencode" | "pi";
    slug: string;
    path: string;
  }>;
  commands: Array<{
    runtime: string;
    harness: "claude" | "codex" | "opencode" | "pi";
    slug: string;
    path: string;
  }>;
};

const RUNTIME_CONFIG_FILE = {
  claude: "settings.json",
  codex: "config.toml",
  opencode: "opencode.jsonc",
  pi: "settings.json",
} as const;

function normalizedConfigDir(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Pure file classifier for v3 native runtime profiles. Native formats remain
 * independent; this only tells the neutral project summary where they live. */
export function discoverRuntimeProjectFiles(
  compiledRuntime: CompiledRuntimeConfig | null,
  filePaths: string[],
): RuntimeFileDiscovery {
  const found: RuntimeFileDiscovery = { configs: [], agents: [], skills: [], commands: [] };
  if (!compiledRuntime) return found;
  const paths = [...new Set(filePaths)].sort();
  const seenAgent = new Set<string>();
  const seenSkill = new Set<string>();
  const seenCommand = new Set<string>();

  for (const [runtime, profile] of Object.entries(compiledRuntime.runtimes).sort(([a], [b]) => a.localeCompare(b))) {
    const configDir = normalizedConfigDir(profile.configDir);
    const base = `${configDir}/`;
    found.configs.push({
      runtime,
      harness: profile.harness,
      configDir: profile.configDir,
      path: `${base}${RUNTIME_CONFIG_FILE[profile.harness]}`,
    });
    for (const path of paths) {
      let nativeName: string | null = null;
      if (profile.harness === "claude") nativeName = path.match(new RegExp(`^${escapeRegExp(base)}agents/([^/]+)\\.md$`))?.[1] ?? null;
      else if (profile.harness === "codex") nativeName = path.match(new RegExp(`^${escapeRegExp(base)}([^/]+)\\.config\\.toml$`))?.[1] ?? null;
      else if (profile.harness === "opencode") nativeName = path.match(new RegExp(`^${escapeRegExp(base)}agents?/([^/]+)\\.md$`))?.[1] ?? null;
      else nativeName = path.match(new RegExp(`^${escapeRegExp(base)}prompts/([^/]+)\\.md$`))?.[1] ?? null;
      if (nativeName) {
        const key = `${profile.harness}:${nativeName}:${path}`;
        if (!seenAgent.has(key)) {
          seenAgent.add(key);
          found.agents.push({ runtime, harness: profile.harness, nativeName, path });
        }
      }

      const skillMatch = path.match(new RegExp(`^${escapeRegExp(base)}skills/(.+)/SKILL\\.md$`));
      const codexGlobalSkill = profile.harness === "codex"
        ? path.match(/^\.agents\/skills\/(.+)\/SKILL\.md$/)
        : null;
      const skillSlug = skillMatch?.[1] ?? codexGlobalSkill?.[1];
      if (skillSlug && !seenSkill.has(path)) {
        seenSkill.add(path);
        found.skills.push({ runtime, harness: profile.harness, slug: skillSlug, path });
      }

      const supportsCommands = profile.harness === "claude" || profile.harness === "opencode";
      const commandMatch = supportsCommands
        ? path.match(new RegExp(`^${escapeRegExp(base)}commands?/([^/]+)\\.md$`))
        : null;
      if (commandMatch?.[1] && !seenCommand.has(path)) {
        seenCommand.add(path);
        found.commands.push({ runtime, harness: profile.harness, slug: commandMatch[1], path });
      }
    }
  }
  return found;
}

export function resolveConfigAgents(
  nativeAgents: NativeAgentSummary[],
  loadedAgents: LoadedAgents,
): Pick<ProjectConfigSummary, "agent_discovery" | "agent_source" | "agents"> {
  if (loadedAgents.specs.length === 0 && loadedAgents.errors.length === 0) {
    return {
      agent_discovery: "runtime",
      agent_source: "native",
      agents: nativeAgents.map((agent) => ({
        ...agent,
        source: "runtime" as const,
        enabled: true,
      })),
    };
  }

  const nativeByName = new Map(
    nativeAgents.map((agent) => [agent.name, agent]),
  );
  const nativeByPath = new Map(
    nativeAgents.map((agent) => [agent.path, agent]),
  );
  return {
    agent_discovery: "declarative",
    agent_source: "declarative",
    agents: loadedAgents.specs
      .filter((spec) => spec.enabled)
      .map((spec) => {
        const native =
          (spec.file ? nativeByPath.get(spec.file) : undefined) ??
          nativeByName.get(spec.name);
        return {
          name: spec.name,
          path: spec.file ?? native?.path ?? spec.path,
          description: native?.description ?? null,
          mode: native?.mode ?? null,
          source: "kortix.yaml" as const,
          enabled: spec.enabled,
          // Surface the per-agent allowlists so the UI can show (read-only) what
          // secrets/connectors/CLI powers each declared agent is scoped to.
          scope: {
            env: spec.env,
            connectors: spec.connectors,
            kortix_cli: spec.kortixCli,
          },
        };
      }),
  };
}

export function attachCompiledRuntimeIdentity(
  agents: ProjectConfigSummary["agents"],
  compiledRuntime: CompiledRuntimeConfig | null,
  nativeAgents: NativeAgentSummary[] = [],
): ProjectConfigSummary["agents"] {
  return agents.map((agent) => {
    const launch = compiledRuntime?.agents[agent.name];
    const native = launch?.nativeAgent
      ? nativeAgents.find((candidate) =>
          candidate.harness === launch.harness &&
          candidate.native_agent === launch.nativeAgent)
      : undefined;
    return {
      ...agent,
      ...(native
        ? {
            path: native.path,
            description: native.description ?? agent.description,
            mode: native.mode ?? agent.mode,
          }
        : {}),
      runtime: launch?.runtime ?? null,
      harness: launch?.harness ?? null,
      native_agent: launch?.nativeAgent ?? null,
    };
  });
}

export async function loadProjectConfig(
  project: GitBackedProject,
  files?: ProjectFileEntry[],
): Promise<ProjectConfigSummary> {
  const repoFiles =
    files ?? (await listRepoFiles(project, project.defaultBranch));
  // Dual-format: resolve kortix.yaml (preferred) or kortix.toml, then parse in
  // the matched format. Without this, a yaml-only project reads no manifest here
  // → its [[agents]] scoping silently vanishes from the config introspection.
  const resolved = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((c) => c.path),
    project.defaultBranch,
  ).catch(() => null);
  const manifestRaw = resolved?.content ?? null;
  const manifestFormat: ManifestFormat = resolved
    ? manifestFormatForPath(resolved.path)
    : "toml";
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
              name: "(manifest)",
              path: manifestFilePath,
              error: "Failed to parse agents declaration",
            },
          ],
        }
      : { specs: [], errors: [] };
  const compiledRuntime = (() => {
    try {
      return parsedManifest ? compileRuntimeConfig(parsedManifest) : null;
    } catch {
      return null;
    }
  })();
  const runtimeFiles = discoverRuntimeProjectFiles(
    compiledRuntime,
    repoFiles.map((file) => file.path),
  );
  const runtimeConfigs = await Promise.all(
    runtimeFiles.configs.map(async (entry) => ({
      runtime: entry.runtime,
      harness: entry.harness,
      config_dir: entry.configDir,
      path: entry.path,
      raw: await optionalFile(project, entry.path),
    })),
  );
  const opencodeDir = resolveOpencodeDir(manifest);
  // Where opencode.jsonc lives. Path comes from the manifest's
  // [opencode] config_dir, defaulting to `.kortix/opencode`.
  const openCodeRaw = await optionalFile(
    project,
    `${opencodeDir}/opencode.jsonc`,
  );

  // Build matchers off the configured opencode dir. The trailing
  // `s?` on agents/commands is opencode's own historical quirk (it
  // accepts both `agent/` and `agents/`); we follow suit.
  const escapedDir = escapeRegExp(opencodeDir);
  const agentRe = new RegExp(`^${escapedDir}/agents?/[^/]+\\.md$`);
  const skillRe = new RegExp(`^${escapedDir}/skills/(.+)/SKILL\\.md$`);
  const commandRe = new RegExp(`^${escapedDir}/commands?/([^/]+)\\.md$`);

  const nativeAgents = await Promise.all(
    runtimeFiles.agents.map(async (entry) => {
      const raw = await optionalFile(project, entry.path);
      const meta = parseFrontmatter(raw);
      return {
        name: meta.name || meta.slug || entry.nativeName,
        path: entry.path,
        description: meta.description || null,
        mode: meta.mode || null,
        runtime: entry.runtime,
        harness: entry.harness,
        native_agent: entry.nativeName,
      };
    }),
  );
  const resolvedAgents = resolveConfigAgents(nativeAgents, loadedAgents);
  const agents = attachCompiledRuntimeIdentity(
    resolvedAgents.agents,
    compiledRuntime,
    nativeAgents,
  );
  const { agent_discovery, agent_source } = resolvedAgents;

  const skills = await Promise.all(
    runtimeFiles.skills.map(async ({ slug, path }) => {
      const raw = await optionalFile(project, path);
      const meta = parseFrontmatter(raw);
      return {
        name: meta.name || slug,
        path,
        description: meta.description || null,
      };
    }),
  );

  const commands = await Promise.all(
    runtimeFiles.commands.map(async ({ slug, path }) => {
      const raw = await optionalFile(project, path);
      const meta = parseFrontmatter(raw);
      return {
        name: meta.name || slug,
        path,
        description: meta.description || null,
      };
    }),
  );

  const signals = {
    manifest: Boolean(manifestRaw),
    runtimeConfig: runtimeConfigs.some((entry) => Boolean(entry.raw)),
    runtimeAgent: agents.length > 0,
  };

  const runtimeDefaultAgent =
    compiledRuntime?.defaultAgent ??
    loadedAgents.defaultAgent ??
    parseJsonCString(openCodeRaw, "default_agent");
  const defaultRuntime = runtimeDefaultAgent
    ? compiledRuntime?.agents[runtimeDefaultAgent]?.runtime
    : null;
  const runtimeConfigRaw =
    runtimeConfigs.find((entry) => entry.runtime === defaultRuntime)?.raw ??
    runtimeConfigs.find((entry) => entry.raw)?.raw ??
    null;

  return {
    is_kortix_repo: Object.values(signals).some(Boolean),
    signals,
    manifest_raw: manifestRaw,
    manifest,
    env: envRequirements(manifest),
    runtime_configs: runtimeConfigs,
    runtime_config_raw: runtimeConfigRaw,
    runtime_default_agent: runtimeDefaultAgent,
    agent_source,
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
  if (opencode && typeof opencode === "object" && !Array.isArray(opencode)) {
    const raw = (opencode as Record<string, unknown>).config_dir;
    if (typeof raw === "string" && raw.trim()) {
      const trimmed = raw.trim();
      // Reject absolute paths + `..` segments here too. parseManifestString
      // already validates the same on the trigger path; this is a
      // belt-and-suspenders since loadProjectConfig uses its own parser.
      if (!trimmed.startsWith("/") && !trimmed.split("/").includes("..")) {
        return trimmed.replace(/\/+$/, "");
      }
    }
  }
  return ".kortix/opencode";
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
