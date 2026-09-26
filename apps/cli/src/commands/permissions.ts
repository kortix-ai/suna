import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  fail,
  missing,
} from '../command-helpers.ts';
import { SCOPE_TYPES, iamBase, type IamPermission } from '../iam.ts';
import { C, help, pad, status } from '../style.ts';

// `kortix permissions` — the permission catalog, as DATA.
//
// One row per leaf action. `scope_type` is the single classifier the engine
// decides on (account or project). `delegable` is the escalation ceiling: a
// non-delegable action can never be handed to a principal who does not already
// hold it. `implies` is what a role that grants this action grants for free.
//
// Roles are built out of these leaves — `kortix roles create … --actions` and
// `kortix roles set-actions` take exactly these keys.

const HELP = help`Usage: kortix permissions <subcommand> [options]

The permission catalog — every leaf action a role can grant, its scope, and
whether it can be delegated. People, groups and service accounts get roles
built from these leaves; agents get Kortix permissions in kortix.yaml.

Subcommands:
  ls [--scope account|project] [--json]   List the catalog.
  show <action> [--json]                  Show one action in full.

Options:
  --scope <s>        account | project — only actions decided at that scope.
  --area <a>         Only actions in one area (e.g. secrets, triggers).
  --account <id>     Operate on this account (default: the active account).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix permissions ls
  kortix permissions ls --scope project
  kortix permissions ls --area secrets
  kortix permissions show project.secret.write
`;

export async function runPermissions(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  try {
    f.scope = takeFlagValue(rest, ['--scope']);
    f.area = takeFlagValue(rest, ['--area']);
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  if (f.scope && !(SCOPE_TYPES as readonly string[]).includes(f.scope)) {
    return fail(`--scope must be one of ${SCOPE_TYPES.join(', ')}`);
  }

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const permissions = await load(ctx.client, ctx.accountId, f.scope);
        const rows = f.area
          ? permissions.filter((p) => p.area.toLowerCase() === f.area!.toLowerCase())
          : permissions;
        if (json) {
          emitJson({ permissions: rows });
          return 0;
        }
        if (rows.length === 0) {
          process.stdout.write(`  ${C.dim}No permissions match.${C.reset}\n`);
          return 0;
        }
        const aw = Math.max(...rows.map((p) => p.action.length), 6);
        const sw = Math.max(...rows.map((p) => p.scope_type.length), 5);
        const rw = Math.max(...rows.map((p) => p.area.length), 4);
        const lw = Math.max(...rows.map((p) => p.level.length), 5);
        process.stdout.write('\n');
        process.stdout.write(
          `  ${C.dim}${pad('ACTION', aw)}   ${pad('SCOPE', sw)}   ${pad('AREA', rw)}   ${pad('LEVEL', lw)}   DELEGABLE${C.reset}\n`,
        );
        for (const p of rows) {
          const delegable = p.delegable ? `${C.faded}yes${C.reset}` : `${C.yellow}no${C.reset}`;
          process.stdout.write(
            `  ${pad(p.action, aw)}   ${pad(p.scope_type, sw)}   ${pad(p.area, rw)}   ${pad(p.level, lw)}   ${delegable}\n`,
          );
        }
        process.stdout.write(
          `\n  ${C.dim}${rows.length} permission${rows.length === 1 ? '' : 's'}` +
            `${rows.some((p) => !p.delegable) ? ' · a non-delegable action can never be handed on' : ''}${C.reset}\n\n`,
        );
        return 0;
      }

      case 'show': {
        const action = positional[0];
        if (!action) return missing('an action key (see `kortix permissions ls`)');
        const permissions = await load(ctx.client, ctx.accountId, f.scope);
        const hit = permissions.find((p) => p.action === action);
        if (!hit) {
          process.stderr.write(
            `${status.err(`No permission "${action}" in the catalog.`)} Try \`kortix permissions ls\`.\n`,
          );
          return 1;
        }
        if (json) {
          emitJson(hit);
          return 0;
        }
        process.stdout.write('\n');
        process.stdout.write(`  ${C.bold}${hit.action}${C.reset}\n`);
        process.stdout.write(`  ${C.dim}${hit.description}${C.reset}\n\n`);
        process.stdout.write(`  ${C.dim}scope${C.reset}      ${hit.scope_type}\n`);
        process.stdout.write(`  ${C.dim}resource${C.reset}   ${hit.resource_type}\n`);
        process.stdout.write(`  ${C.dim}area${C.reset}       ${hit.area}\n`);
        process.stdout.write(`  ${C.dim}level${C.reset}      ${hit.level}\n`);
        process.stdout.write(
          `  ${C.dim}delegable${C.reset}  ${hit.delegable ? 'yes' : `no ${C.faded}(can never be handed on)${C.reset}`}\n`,
        );
        if (hit.implies.length > 0) {
          process.stdout.write(`\n  ${C.dim}IMPLIES (${hit.implies.length})${C.reset}\n`);
          for (const a of hit.implies.slice().sort()) process.stdout.write(`    ${a}\n`);
        }
        process.stdout.write('\n');
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

async function load(
  client: { get: <T>(p: string) => Promise<T> },
  accountId: string,
  scope: string | undefined,
): Promise<IamPermission[]> {
  const qs = scope ? `?scope_type=${encodeURIComponent(scope)}` : '';
  const { permissions } = await client.get<{ permissions: IamPermission[] }>(
    `${iamBase(accountId)}/permissions${qs}`,
  );
  return permissions;
}
