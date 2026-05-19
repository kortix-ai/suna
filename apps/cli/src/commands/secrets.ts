import { readFileSync } from 'node:fs';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type {
  ProjectSecret,
  ProjectSecretsResponse,
} from '../api/types.ts';

const HELP = `Usage: kortix secrets <subcommand> [options]

Manage encrypted env-var secrets on the linked Kortix project. Values
are AES-256-GCM-encrypted at rest and injected into session sandboxes
at boot.

Subcommands:
  ls                                List secret names + manifest [env] spec.
  set NAME=VALUE [NAME=VALUE …]     Upsert one or more secrets.
                                    Use \`NAME=-\` to read VALUE from stdin.
  unset NAME [NAME …]               Remove one or more secrets.

Global options:
  --project <id>     Operate on this project id (default: linked or
                     \$KORTIX_PROJECT_ID).
  -h, --help         Show this help.
`;

export async function runSecrets(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  switch (sub) {
    case 'ls':
      return secretsLs(projectFlag);
    case 'set':
      return secretsSet(rest, projectFlag);
    case 'unset':
    case 'rm':
    case 'remove':
      return secretsUnset(rest, projectFlag);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function secretsLs(projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  let resp: ProjectSecretsResponse;
  try {
    resp = await ctx.client.get<ProjectSecretsResponse>(
      `/projects/${ctx.projectId}/secrets`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const setNames = new Set(resp.items.map((s) => s.name));
  const requiredMissing = resp.required.filter((n) => !setNames.has(n));
  const declared = new Set([...resp.required, ...resp.optional]);
  const undeclared = resp.items.filter((s) => !declared.has(s.name));

  process.stdout.write('\n');
  if (resp.manifest_status !== 'loaded') {
    process.stdout.write(
      `  ${C.dim}Manifest: ${resp.manifest_status}${
        resp.manifest_error ? ` — ${resp.manifest_error}` : ''
      }${C.reset}\n\n`,
    );
  }

  if (resp.items.length === 0 && resp.required.length === 0 && resp.optional.length === 0) {
    process.stdout.write(`  ${C.dim}No secrets set, no [env] spec in kortix.toml.${C.reset}\n\n`);
    return 0;
  }

  const allRows: { name: string; spec: string; set: boolean }[] = [];
  for (const name of resp.required) {
    allRows.push({ name, spec: 'required', set: setNames.has(name) });
  }
  for (const name of resp.optional) {
    allRows.push({ name, spec: 'optional', set: setNames.has(name) });
  }
  for (const s of undeclared) {
    allRows.push({ name: s.name, spec: 'undeclared', set: true });
  }

  const nameW = Math.max(...allRows.map((r) => r.name.length), 4);
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   STATUS    SPEC${C.reset}\n`,
  );
  for (const r of allRows) {
    const marker = r.set ? `${C.green}● ${C.reset}` : `${C.yellow}○ ${C.reset}`;
    const statusTxt = r.set ? 'set     ' : 'missing ';
    const specColor =
      r.spec === 'required' && !r.set
        ? C.yellow
        : r.spec === 'undeclared'
          ? C.faded
          : C.dim;
    process.stdout.write(
      `${marker}${pad(r.name, nameW)}   ${statusTxt}  ${specColor}${r.spec}${C.reset}\n`,
    );
  }

  process.stdout.write('\n');
  if (requiredMissing.length > 0) {
    process.stdout.write(
      `  ${status.warn(
        `${requiredMissing.length} required secret${
          requiredMissing.length === 1 ? '' : 's'
        } missing — sessions will start but may misbehave.`,
      )}\n`,
    );
  }
  process.stdout.write(
    `  ${C.dim}${resp.items.length} set · ${resp.required.length} required · ${resp.optional.length} optional${C.reset}\n\n`,
  );
  return 0;
}

async function secretsSet(args: string[], projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;
  if (args.length === 0) {
    process.stderr.write(`${status.err('Pass at least one NAME=VALUE pair.')}\n`);
    return 2;
  }

  const pairs: { name: string; value: string }[] = [];
  let stdinUsed = false;
  for (const raw of args) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`${status.err(`malformed pair "${raw}" — expected NAME=VALUE`)}\n`);
      return 2;
    }
    const name = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1);
    if (value === '-') {
      if (stdinUsed) {
        process.stderr.write(`${status.err('Only one NAME=- per invocation.')}\n`);
        return 2;
      }
      stdinUsed = true;
      value = readFileSync(0, 'utf8').replace(/\n$/, '');
    }
    pairs.push({ name, value });
  }

  let okCount = 0;
  for (const p of pairs) {
    try {
      await ctx.client.post<ProjectSecret>(
        `/projects/${ctx.projectId}/secrets`,
        { name: p.name, value: p.value },
      );
      okCount += 1;
      process.stdout.write(`${status.ok(`${C.bold}${p.name}${C.reset}`)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${p.name}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${pairs.length} set${C.reset}\n\n`);
  return okCount === pairs.length ? 0 : 1;
}

async function secretsUnset(names: string[], projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret name to unset.')}\n`);
    return 2;
  }

  let okCount = 0;
  for (const name of names) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/secrets/${encodeURIComponent(name)}`);
      okCount += 1;
      process.stdout.write(`${status.ok(`removed ${C.bold}${name}${C.reset}`)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${name}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${names.length} removed${C.reset}\n\n`);
  return okCount === names.length ? 0 : 1;
}
