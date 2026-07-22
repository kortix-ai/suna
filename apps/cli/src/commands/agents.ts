import { HARNESSES, HARNESS_IDS, type HarnessId } from '@kortix/shared/harnesses';

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// Mirrors GET /projects/:id/model-defaults (apps/api/src/projects/routes/model-defaults.ts).
interface ModelDefaults {
  platformDefault: string | null;
  accountDefault: string | null;
  projectDefault: string | null;
  agentDefaults: Record<string, string>;
  resolvedForCaller: string | null;
}

const HELP = help`Usage: kortix agents <subcommand> [options]

Per-agent settings on the linked Kortix project. Today: which MODEL each agent
runs on — the dynamic gateway default (scope=agent), applied instantly with no
kortix.yaml commit. A session an agent runs that asks for the synthetic \`auto\`
model resolves to this pick, falling back to the project → account → platform
default. (The declarative default lives in kortix.yaml as [[agents]].model.)

Subcommands:
  models [--json]                 Show every agent's pinned model + the fallback default.
  model <agent> <provider/model>  Pin an agent to a model (e.g. opencode anthropic/claude-opus-4-8).
  model <agent> --clear           Clear the pin — the agent follows the default again.

Note: an agent NAMED after a harness that owns its own default model
(claude, codex) rejects a pin here — that harness always uses its own
default, so this table would silently have no effect. OpenCode and Pi
(and any custom-named agent that doesn't run one of those harnesses)
are settable with this command.

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

export async function runAgents(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let json = false;
  let clear = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    clear = takeFlagBool(rest, ['--clear', '--default', '--reset']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  // Refuse before touching the network: `account_model_preferences` (this
  // command's backing table) is only consulted when the harness itself
  // doesn't own its default model (`HARNESSES[id].ownsDefaultModel`). Claude
  // Code and Codex own theirs (Pi is gateway/catalog-driven since the
  // 2026-07-21 refactor) — pinning a model for an agent named
  // after one of them here would write a row that's provably never read,
  // and printing success for that is a silent-failure bug in its own right.
  // Detection is name-based: an agent whose name matches a harness id that
  // owns its default (the same convention this command's own help example
  // used to demonstrate the bug) is refused. An agent with a custom name
  // that happens to run one of those harnesses isn't caught by this — the
  // CLI has no local way to resolve agent name -> harness today; see the
  // `kortix models` proposal in docs/specs/2026-07-21-cli-credential-model-ux.md.
  if (sub === 'model' && !clear) {
    const agentArg = positional[0];
    const inertHarness = ownsDefaultModelHarness(agentArg);
    if (inertHarness) {
      process.stderr.write(
        `${status.err(`"${inertHarness}" owns its own default model — this command can't change it.`)}\n` +
          `  ${C.dim}Claude Code and Codex always use their own default model; they${C.reset}\n` +
          `  ${C.dim}never read account_model_preferences (the table this command writes).${C.reset}\n` +
          `  ${C.dim}OpenCode and Pi are settable this way.${C.reset}\n`,
      );
      return 1;
    }
  }

  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/model-defaults`;

  try {
    switch (sub) {
      case 'models':
      case 'ls':
      case 'list': {
        const d = await ctx.client.get<ModelDefaults>(base);
        if (json) {
          emitJson(d);
          return 0;
        }
        const fallback = d.projectDefault ?? d.accountDefault ?? d.platformDefault ?? 'auto';
        const entries = Object.entries(d.agentDefaults ?? {});
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}Default (project → account → platform): ${C.reset}${C.bold}${fallback}${C.reset}\n\n`,
        );
        if (entries.length === 0) {
          process.stdout.write(
            `  ${C.dim}No per-agent model pins — every agent follows the default.${C.reset}\n` +
              `  ${C.dim}Pin one: ${C.reset}${C.cyan}kortix agents model <agent> <provider/model>${C.reset}\n\n`,
          );
          return 0;
        }
        const w = Math.max(...entries.map(([n]) => n.length), 5);
        for (const [name, model] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
          process.stdout.write(`  ${pad(name, w)}   ${C.cyan}${model}${C.reset}\n`);
        }
        process.stdout.write(
          `\n  ${C.dim}${entries.length} pinned · the rest follow the default${C.reset}\n\n`,
        );
        return 0;
      }
      case 'model': {
        const agent = positional[0];
        if (!agent) return missing('an agent name');
        if (clear) {
          await ctx.client.delete(`${base}?scope=agent&agentName=${encodeURIComponent(agent)}`);
          process.stdout.write(
            `${status.ok(`${C.bold}${agent}${C.reset} follows the default model again`)}\n`,
          );
          return 0;
        }
        const model = positional[1];
        if (!model)
          return missing('a model (e.g. opencode anthropic/claude-opus-4-8) — or --clear');
        await ctx.client.put(base, { scope: 'agent', agentName: agent, model });
        process.stdout.write(
          `${status.ok(`${C.bold}${agent}${C.reset} → ${C.cyan}${model}${C.reset}`)} ${C.dim}(applies to new sessions)${C.reset}\n`,
        );
        return 0;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

/** Return the harness id when `agentName` is (case-sensitively) exactly a
 *  known harness id AND that harness owns its own default model — the
 *  narrow, name-based signal this command can check without resolving
 *  kortix.yaml's agent → runtime → harness mapping (no local manifest, and
 *  the API this command hits doesn't return that mapping either). `null`
 *  for anything else, including custom agent names this heuristic can't see
 *  through. */
export function ownsDefaultModelHarness(agentName: string | undefined): HarnessId | null {
  if (!agentName) return null;
  const id = (HARNESS_IDS as readonly string[]).find((h) => h === agentName) as
    | HarnessId
    | undefined;
  if (!id) return null;
  return HARNESSES[id].ownsDefaultModel ? id : null;
}
