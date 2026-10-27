/**
 * One agent's capability catalog: every tool, skill and extension a session
 * of the agent can have, with the text that describes it. Served by
 * GET /v1/projects/:projectId/agents/:agentName/capabilities; the agent page
 * draws its switches from it, so no host keeps its own list.
 *
 * Whether an item is ON is the agent's grant (`agents.<name>.tools`,
 * `.skills`, `.extensions`), not this catalog. `@kortix/sdk`'s
 * `capabilityGranted` / `setCapabilityGranted` read and write it.
 *
 * Sources:
 *  - tools: the tools pi registers (`harness/pi/runtime.ts` base tools,
 *    the `kortix-subagents` extension's `agent` + its `task` alias, codemode),
 *    `KORTIX_TOOL_NAMES`, and the manifest's `tools:` registry. The model reads
 *    each tool module's own long description; the one-line text here is for
 *    people.
 *  - skills: the Kortix skill files (`skills/catalog.ts`, SKILL.md frontmatter
 *    `description` and `metadata.kortix-feature-flag`) and the `skills:`
 *    registry.
 *  - extensions: the platform extensions `harness/pi/runtime.ts` loads, and
 *    the `extensions:` registry.
 */

import { KORTIX_SKILL_NAMES, KORTIX_TOOL_NAMES, kortixToolRef, selectedKortixTools } from '@kortix/manifest-schema';

export type AgentCapabilityToolGroup = 'workspace' | 'interaction' | 'kortix' | 'project';

export interface AgentCapabilityTool {
  id: string;
  group: AgentCapabilityToolGroup;
  description: string | null;
  aliases: string[];
  source: string | null;
}

export interface AgentCapabilitySkill {
  id: string;
  group: 'builtin' | 'project';
  description: string | null;
  feature_flag: string | null;
  available: boolean;
}

export interface AgentCapabilityExtension {
  id: string;
  group: 'platform' | 'project';
  description: string | null;
  required: boolean;
  controlled_by: string | null;
}

export interface AgentCapabilities {
  agent: string;
  schema_version: number;
  tools: AgentCapabilityTool[];
  skills: AgentCapabilitySkill[];
  extensions: AgentCapabilityExtension[];
}

/** The built-in tools, in the order the agent page lists them. */
const BUILTIN_TOOLS: ReadonlyArray<{ id: string; group: AgentCapabilityToolGroup; description: string; aliases?: string[] }> = [
  { id: 'bash', group: 'workspace', description: 'Run shell commands in the session sandbox.' },
  { id: 'read', group: 'workspace', description: 'Read files.' },
  { id: 'write', group: 'workspace', description: 'Create or overwrite files.' },
  { id: 'edit', group: 'workspace', description: 'Change part of a file.' },
  { id: 'glob', group: 'workspace', description: 'Find files by name pattern.' },
  { id: 'grep', group: 'workspace', description: 'Search inside files.' },
  { id: 'codemode', group: 'workspace', description: 'Write one script that calls the other tools.' },
  { id: 'question', group: 'interaction', description: 'Ask you a question and wait for the answer.' },
  { id: 'agent', group: 'interaction', description: 'Hand work to a subagent and get its result.', aliases: ['task'] },
];

/** One line per Kortix tool (`apps/kortix-sandbox-agent-server/src/services/tools/kortix/`). */
const KORTIX_TOOL_DESCRIPTIONS: Record<(typeof KORTIX_TOOL_NAMES)[number], string> = {
  web_search: 'Search the web for current information.',
  image_search: 'Search the web for images.',
  scrape_webpage: 'Read web pages as clean text.',
  memory: 'Read and write the project memory in memory/.',
  show: 'Show you a file, image or result in the conversation.',
};

/** The extensions the pi runtime loads for every agent (`harness/pi/runtime.ts`). */
const PLATFORM_EXTENSIONS: readonly AgentCapabilityExtension[] = [
  { id: 'kortix-nested-calls', group: 'platform', required: true, controlled_by: null, description: "Applies this agent's permission rules to the tool calls a script makes." },
  { id: 'kortix-presentation', group: 'platform', required: true, controlled_by: null, description: 'Shows what the show tool presents as its own part of the conversation.' },
  { id: 'kortix-turn', group: 'platform', required: true, controlled_by: null, description: "Tells the agent today's date and the turn's system text on every turn." },
  { id: 'kortix-subagents', group: 'platform', required: false, controlled_by: 'agent', description: 'Adds the agent tool, which starts subagents.' },
  { id: 'codemode', group: 'platform', required: false, controlled_by: 'codemode', description: 'Adds the codemode tool.' },
];

function mapOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The implementation an extension names: its pi source, else its OpenCode module. */
function extensionSource(entry: unknown): string | null {
  const { pi, opencode } = mapOf(entry);
  const source = typeof pi === 'string' ? pi : mapOf(pi).source;
  if (typeof source === 'string') return source;
  return typeof opencode === 'string' ? opencode : null;
}

export function buildAgentCapabilities(input: {
  agentName: string;
  manifest: Record<string, unknown>;
  schemaVersion: number;
  managedSkills: ReadonlyArray<{ name: string; description: string; featureFlag: string | null }>;
  /** Project skill name → its SKILL.md `description`, when the file was read. */
  projectSkillDescriptions: Record<string, string | null>;
  enabledFlags: ReadonlySet<string>;
}): AgentCapabilities {
  // `kortix:<name>` keeps a Kortix tool (v2); any other value is a repository module.
  const registeredTools = Object.entries(mapOf(input.manifest.tools)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && kortixToolRef(entry[1]) === null,
  );
  const replaced = new Map(registeredTools);
  const kortixNames = new Set<string>(KORTIX_TOOL_NAMES);
  // v3 sessions load every Kortix tool; a v2 `tools` key keeps only the ones it lists.
  const kortixTools = input.schemaVersion >= 3 ? [...KORTIX_TOOL_NAMES] : selectedKortixTools(input.manifest.tools);
  const tools: AgentCapabilityTool[] = [
    ...BUILTIN_TOOLS.map((tool) => ({ id: tool.id, group: tool.group, description: tool.description, aliases: tool.aliases ?? [], source: null })),
    ...kortixTools.map((id) => ({
      id,
      group: 'kortix' as const,
      description: KORTIX_TOOL_DESCRIPTIONS[id as keyof typeof KORTIX_TOOL_DESCRIPTIONS],
      aliases: [],
      source: replaced.get(id) ?? null,
    })),
    ...registeredTools
      .filter(([id]) => !kortixNames.has(id))
      .map(([id, source]) => ({ id, group: 'project' as const, description: null, aliases: [], source })),
  ];

  const managed = new Map(input.managedSkills.map((skill) => [skill.name, skill]));
  const builtinNames = [...new Set([...KORTIX_SKILL_NAMES, ...managed.keys()])].sort();
  const skills: AgentCapabilitySkill[] = [
    ...builtinNames.map((id) => {
      const flag = managed.get(id)?.featureFlag ?? null;
      return {
        id,
        group: 'builtin' as const,
        description: managed.get(id)?.description || null,
        feature_flag: flag,
        available: !flag || input.enabledFlags.has(flag),
      };
    }),
    ...Object.keys(mapOf(input.manifest.skills))
      .sort()
      .map((id) => ({ id, group: 'project' as const, description: input.projectSkillDescriptions[id] ?? null, feature_flag: null, available: true })),
  ];

  const extensions: AgentCapabilityExtension[] = [
    ...PLATFORM_EXTENSIONS,
    ...Object.entries(mapOf(input.manifest.extensions)).map(([id, entry]) => ({
      id,
      group: 'project' as const,
      description: extensionSource(entry),
      required: false,
      controlled_by: null,
    })),
  ];

  return { agent: input.agentName, schema_version: input.schemaVersion, tools, skills, extensions };
}
