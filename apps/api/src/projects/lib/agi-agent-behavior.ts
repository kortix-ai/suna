/**
 * The platform AGI's BEHAVIOR — the half of R-34 a grant cannot carry.
 *
 * A grant answers "what may this session call". It says nothing about
 * claim-before-work, no-retry-on-409, parent-is-not-dependency,
 * background-process-is-not-progress, or bounded escalation. Those rules live in
 * the AGI's behavior file, `packages/starter/templates/agi/agents/kortix-agi.md`
 * — and until now they only reached a human's laptop, because `kortix agi`
 * materializes that file locally. A trigger-fired session had the name and the
 * authority and none of the discipline: OpenCode, handed an agent name it has no
 * config for, silently runs its default agent instead.
 *
 * This module closes that. The bundled behavior file is compiled into the same
 * `agent.<name>` entry a declared v2 agent produces and folded into
 * `KORTIX_COMPILED_AGENT_CONFIG`, which the sandbox daemon already consumes as
 * the BASE of its composed OpenCode config (see
 * apps/kortix-sandbox-agent-server/src/opencode.ts). So:
 *
 *   - R-35 holds: no manifest entry, no `agents:` block, no repo file.
 *   - R-36 holds: it arrives entirely through the environment at boot, so the
 *     AGI needs no checkout to start.
 *   - R-34 holds: it is the SAME bytes in every workspace, and it is applied
 *     LAST so a project that writes its own `kortix-agi` behavior file cannot
 *     replace the platform agent with a lookalike.
 */
import { getAgiFiles } from '@kortix/starter';
import { AGI_AGENT_NAME } from '../agents';
import { parseAgentMarkdown } from './agent-markdown';
import {
  BEHAVIOR_FRONTMATTER_KEYS,
  type OpencodeAgentConfig,
  type OpencodeConfig,
} from './compile-agent-config';

/** Path of the AGI behavior file WITHIN the bundled `agi` template root (the
 *  shape `getAgiFiles()` returns — template-relative, not repo-relative). */
const AGI_BEHAVIOR_FILE = `agents/${AGI_AGENT_NAME}.md`;

/** Compiled once: the bundled template is part of the deployed artifact and
 *  cannot change between sessions, and every trigger fire would otherwise
 *  re-read + re-parse it. `null` memoizes a genuine absence too — see
 *  `agiOpencodeAgentConfig`. */
let cached: OpencodeAgentConfig | null | undefined;

/**
 * Compile the bundled behavior file into one OpenCode agent config, or `null`
 * when it is missing/empty — a packaging defect (the template failed to embed),
 * never an authoring error a workspace can cause.
 *
 * Frontmatter is copied through by the SAME key list the v2 manifest compiler
 * uses, so the platform agent and a declared agent support exactly the same
 * behavioral surface and cannot drift. Unlike the manifest compiler this never
 * throws on bad frontmatter: the file ships with the platform, so a defect in it
 * must not be able to fail every AGI session boot — `withPlatformAgiAgent`
 * degrades loudly instead.
 */
export function agiOpencodeAgentConfig(): OpencodeAgentConfig | null {
  if (cached !== undefined) return cached;
  cached = compileAgiBehavior();
  return cached;
}

function compileAgiBehavior(): OpencodeAgentConfig | null {
  let content: string | undefined;
  try {
    content = getAgiFiles().find((f) => f.path === AGI_BEHAVIOR_FILE)?.content;
  } catch (err) {
    console.error(`[agi-agent] bundled AGI template is unavailable: ${(err as Error).message}`);
    return null;
  }
  if (!content?.trim()) return null;

  const { frontmatter, body } = parseAgentMarkdown(content);
  const out: OpencodeAgentConfig = {};
  for (const key of BEHAVIOR_FRONTMATTER_KEYS) {
    if (frontmatter[key] !== undefined) {
      (out as Record<string, unknown>)[key] = frontmatter[key];
    }
  }
  // The body IS the operating discipline. A behavior entry without it would
  // hand the session the AGI's name and authority and none of its rules —
  // exactly the failure this module exists to prevent.
  if (!body.trim()) return null;
  out.prompt = body;
  return out;
}

/**
 * Fold the platform AGI into a session's compiled OpenCode agent config.
 *
 * `compiledAgentConfig` is whatever `resolveCompiledAgentConfigForSession`
 * produced — a JSON string for a v2 project, `null` for a v1 project or any
 * read/parse failure. Either way the AGI entry is added, because the AGI's
 * behavior does not come from the project and must not depend on the project's
 * manifest version or on that read succeeding.
 *
 * Applied LAST and unconditionally on the `kortix-agi` key: a project cannot
 * substitute its own behavior for the platform agent's, which is the runtime
 * counterpart of the reserved-name rule in `../agents.ts`.
 *
 * Returns the input unchanged when the bundled file is unavailable — a session
 * that boots on the project's default behavior is bad, but a session that fails
 * to boot at all is worse, and the warning names the cause.
 */
export function withPlatformAgiAgent(compiledAgentConfig: string | null): string | null {
  const behavior = agiOpencodeAgentConfig();
  if (!behavior) {
    console.error(
      '[agi-agent] bundled AGI behavior file is missing or empty — this session runs without the AGI operating rules',
    );
    return compiledAgentConfig;
  }

  let base: OpencodeConfig = { agent: {} };
  if (compiledAgentConfig) {
    try {
      const parsed: unknown = JSON.parse(compiledAgentConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const existing = parsed as Partial<OpencodeConfig>;
        base = {
          ...existing,
          agent: { ...(existing.agent ?? {}) },
        };
      }
    } catch {
      // The compiler emitted this string, so a parse failure is a bug rather
      // than user input. Overlay onto a fresh config instead of dropping the
      // AGI's rules along with the unreadable half.
      console.warn('[agi-agent] compiled agent config was not valid JSON; rebuilding it');
    }
  }
  base.agent[AGI_AGENT_NAME] = behavior;
  return JSON.stringify(base);
}
