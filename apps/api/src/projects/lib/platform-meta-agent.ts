// No runtime imports beyond @kortix/shared: `projects/agents.ts` resolves the
// coordinator's grant from here, and `projects/git/config.ts` imports that —
// which `e2e-project-session-branch-git` loads in a `bun --eval` subprocess and
// parses stdout from. Pulling `feature-flags/registry` (and through it the
// config module, which banners on stdout) into that chain breaks it. The
// legacy per-project switch is read at each call site with the canonical
// `resolveFeatureFlag(metadata, 'meta_agent')` and passed to
// `resolveBuiltinAgents` below as the fallback. Type imports are erased and
// cost nothing.
//
// My Kortix is the platform's built-in agent. Its slug stays `meta`: session
// rows, token grants, the sandbox slug, image names and the config-release
// variant all key on it. Users only ever see the display name.
//
// My Kortix is an ordinary kortix.yaml v3 agent: `MY_KORTIX_BLOCK` below is
// its `agents.meta` block. Every path a declared agent takes reads it:
//   - compile: `compileMyKortixAgentConfig` (compile-agent-config.ts) injects
//     it as `agents.meta` into the project's v3 manifest and runs the v3
//     compiler for the selected agent `meta`;
//   - grant and sandbox pin: `MY_KORTIX_SPEC` (agents/grants.ts) is this block
//     through the same parser as a kortix.yaml block (`parseAgentBlock`);
//   - roster row: `withMyKortixAgent` (builtin-agents.ts) runs the manifest
//     summarizer (`resolveConfigAgents`) on that spec;
//   - GET /agents/meta/config: the v3 view (`agentConfigViewV3`) of this block.
//
// The ONLY differences from a declared agent:
//   (a) The block comes from the server, not from kortix.yaml. A project
//       cannot declare `agents.meta` (the v3 validator reserves the slug).
//   (b) It acts as the person who starts the session, not as its own agent
//       principal (iam/agent-principal.ts `isGovernedAgentGrant`), and gets
//       no standing service account (platform/services/session-sandbox.ts).
//   (c) It is never editable or deletable: every config write answers
//       `409 builtin_agent_managed` (`builtinAgentWriteRefusal`).
//       `builtin_agents.my_kortix: false` in kortix.yaml removes it; a session
//       create for it then answers `409 builtin_agent_disabled`, and an
//       existing `meta` session falls to the deny-all grant.
//   (d) What is not unified yet, and why:
//       - Sandbox lock: an explicit `sandbox_slug` other than `meta` answers
//         `400 META_SANDBOX_LOCKED` (`resolvePlatformMetaSandbox`). A declared
//         agent's `sandbox` is a default an explicit request overrides; the
//         `meta` sandbox has no project checkout, so an override would run
//         My Kortix in a box built for a different agent.
//       - No checkout: `workspace.project_repository: false` is declared, but
//         a `meta` session row still records `repository_access: true` and
//         provisioning withholds the clone (`KORTIX_PROJECT_AUTO_CLONE=0`,
//         the governance-only `meta` config-release variant). The human's
//         file access to the session reads `repository_access`; flipping it
//         for `meta` would close the session's Files view.
//       - The `meta` session is the default agent of a project unless
//         `builtin_agents.my_kortix: false`, and a `meta` session cannot start
//         another `meta` session (`409 META_AGENT_RECURSION`).
//       - It compiles also in a v1/v2 project (alone, without project agents).
import {
  BUILTIN_AGENT_KEYS,
  builtinAgentKeyOf,
  BUILTIN_AGENTS,
  type BuiltinAgentKey,
  META_SANDBOX_SLUG,
} from '@kortix/shared';
import type { AgentBlockV3 } from '@kortix/manifest-schema';

/** My Kortix's one-line description, the same in the agent list and the compiled config. */
export const MY_KORTIX_DESCRIPTION =
  'The one agent you talk to. It routes each task to the agent made for it and runs it, with your permissions.';

/**
 * The `builtin_agents` values a manifest sets explicitly. Only booleans count;
 * an absent key (or a v1/v2 manifest, whose validator refuses the key) says
 * nothing.
 */
export function declaredBuiltinAgents(
  manifest: Record<string, unknown> | null | undefined,
): Partial<Record<BuiltinAgentKey, boolean>> {
  const node = manifest?.builtin_agents;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  const declared: Partial<Record<BuiltinAgentKey, boolean>> = {};
  for (const key of BUILTIN_AGENT_KEYS) {
    const value = (node as Record<string, unknown>)[key];
    if (typeof value === 'boolean') declared[key] = value;
  }
  return declared;
}

/**
 * Which built-in agents this project runs. Per key: the manifest's boolean
 * (the repository is the source of truth), else the legacy per-project
 * `meta_agent` switch the caller resolved, else on.
 */
export function resolveBuiltinAgents(
  declared: Partial<Record<BuiltinAgentKey, boolean>>,
  legacyMetaAgent: boolean,
): Record<BuiltinAgentKey, boolean> {
  return { my_kortix: declared.my_kortix ?? legacyMetaAgent };
}

/**
 * The built-in agent `agentName` names, when the project runs it. `null` for a
 * declared agent, and for a built-in the project turned off: that name is then
 * an ordinary (undeclared) agent name.
 */
export function enabledBuiltinAgentKey(
  agentName: string | null | undefined,
  builtinAgents: Record<BuiltinAgentKey, boolean>,
): BuiltinAgentKey | null {
  const key = builtinAgentKeyOf(agentName);
  return key && builtinAgents[key] ? key : null;
}

/** The refusal for a write that targets a built-in agent's configuration. */
export function builtinAgentWriteRefusal(key: BuiltinAgentKey) {
  return {
    error: `${BUILTIN_AGENTS[key].displayName} is built in: Kortix maintains its prompt, tools and model. To remove it from this project, set \`builtin_agents: { ${key}: false }\` in kortix.yaml.`,
    code: 'builtin_agent_managed' as const,
  };
}

/**
 * My Kortix's system prompt. It delegates with the `agent` tool, which starts
 * the child session, waits for it and returns its final message in one call:
 * driving `kortix sessions new` / `wait-for` / `cp` from bash hits the 30 s
 * bash timeout and echoes the CLI banner into the chat. Generative UI is
 * always on and the `kortix-genui` skill is always listed, so the prompt tells
 * it when to answer with `openui` blocks instead of prose.
 */
export const MY_KORTIX_PROMPT = [
  "You are My Kortix, the one agent the user talks to in this project. Follow /workspace/AGENTS.md. You act with the user's own permissions.",
  'Answer questions and configure the project yourself (agents, triggers, grants, connectors) with the Kortix CLI.',
  'Delegate every production task to the narrowest project agent with the `agent` tool. Leave `session` at its default (`separate`): one call starts that agent\'s own session (the user can open it), waits until it finishes (up to 30 minutes) and returns its final message. Use `session: "same"` only for quick sub-steps. Never delegate or wait with `kortix sessions new`, `kortix sessions wait-for` or `kortix sessions cp`.',
  'Tell the agent to put everything you need in its final message: the answer, and the path of every file it wrote. Read the result; do not copy files out of its session. Then report the verified result.',
  'You work in codemode. Call `agent`, `question` and `show` directly. Every other tool (bash, read, web search, the Kortix CLI through bash) runs from a codemode script: `await tools.<name>(args)`.',
  'Prefer generative UI: when an answer is a plan, comparison, ranking, list of places or options, steps, a checklist, or 2 or more numbers, load the `kortix-genui` skill first and answer with `openui` blocks. Keep chat, short facts and code as prose.',
].join('\n\n');

/**
 * My Kortix's `agents.meta` block. The server owns it; see the header for how
 * every declared-agent path reads it. `codemode: 'only'` is the one setting
 * that differs from the configuration My Kortix ran with before it became a
 * block: the model sees codemode plus the tools a script may not call
 * (`agent`, `task`, `question`) and the presentation tools (`show`,
 * `image_gen`), all direct.
 */
export const MY_KORTIX_BLOCK = {
  description: MY_KORTIX_DESCRIPTION,
  mode: 'primary',
  prompt: MY_KORTIX_PROMPT,
  codemode: 'only',
  tools: 'all',
  skills: 'all',
  subagents: 'all',
  commands: 'all',
  connectors: 'none',
  secrets: 'none',
  apps: 'none',
  kortix_permissions: 'all',
  workspace: { project_repository: false },
  sandbox: META_SANDBOX_SLUG,
} as const satisfies AgentBlockV3;

/** My Kortix always runs in its own `meta` sandbox; see (d) in the header. */
export function resolvePlatformMetaSandbox(requestedSlug: string | null | undefined): string {
  if (requestedSlug && requestedSlug !== MY_KORTIX_BLOCK.sandbox) {
    throw new Error('META_SANDBOX_LOCKED');
  }
  return MY_KORTIX_BLOCK.sandbox;
}
