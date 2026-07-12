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
  model <agent> <provider/model>  Pin an agent to a model (e.g. anthropic/claude-opus-4-8).
  model <agent> --clear           Clear the pin — the agent follows the default again.

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
        const fallback =
          d.projectDefault ?? d.accountDefault ?? d.platformDefault ?? 'auto';
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
          await ctx.client.delete(
            `${base}?scope=agent&agentName=${encodeURIComponent(agent)}`,
          );
          process.stdout.write(
            `${status.ok(`${C.bold}${agent}${C.reset} follows the default model again`)}\n`,
          );
          return 0;
        }
        const model = positional[1];
        if (!model) return missing('a model (e.g. anthropic/claude-opus-4-8) — or --clear');
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
