/**
 * `kortix migrate` — convert this project's kortix.yaml from kortix_version 2
 * to 3 (`planMigration` in ../manifest-migrate.ts). A preview by default;
 * `--write` applies it. Nothing is written or deleted without `--write`, and
 * nothing is written when the result does not validate.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { formatIssues, parseManifestText } from '@kortix/manifest-schema';
import { emitJson, takeFlagBool } from '../command-helpers.ts';
import { type MigrationPlan, planMigration } from '../manifest-migrate.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix migrate [--write] [--json]

Convert this project's kortix.yaml from kortix_version 2 to 3. v3 defines each
agent in one kortix.yaml block: the project registers skills, tools, commands
and extensions, and each agent enables what it uses.

What it does:
  - Each agent's .md frontmatter moves into its kortix.yaml block; the .md
    keeps the prompt alone and becomes the agent's prompt_file.
  - opencode.json(c)'s permission is copied onto every agent that sets none,
    and the file is deleted.
  - skills/<name>/ folders become the skills registry.
  - OpenCode commands become the commands registry, each enabled on the agent
    its frontmatter names, else default_agent.
  - OpenCode plugins and harnesses.pi.packages become extensions, enabled on
    every agent that loaded them.

Without --write it prints the plan and the new kortix.yaml and changes nothing.
The result is checked with the v3 validator; --write refuses an invalid result.

Options:
  --write       Apply the plan: write kortix.yaml and the prompt files, delete
                opencode.json(c).
  --json        Machine-readable plan.
  -h, --help    Show this help.

Then: kortix validate, commit, and open a change request.
`;

export function runMigrate(argv: string[]): number {
  if (argv.some((arg) => arg === '-h' || arg === '--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const rest = [...argv];
  const write = takeFlagBool(rest, ['--write']);
  const json = takeFlagBool(rest, ['--json']);
  if (rest.length > 0) {
    process.stderr.write(`unknown option "${rest[0]}"\n\n${HELP}`);
    return 2;
  }

  const found = resolveLocalManifest(process.cwd());
  if (!found) {
    process.stderr.write(`${status.err('Manifest not found')}\n  ${C.dim}Run from your project root (the folder with kortix.yaml).${C.reset}\n`);
    return 2;
  }
  const root = dirname(found.path);
  let raw: Record<string, unknown>;
  try {
    raw = parseManifestText(readFileSync(found.path, 'utf8'), found.format);
  } catch (err) {
    process.stderr.write(`${status.err(`cannot parse ${basename(found.path)}: ${(err as Error).message}`)}\n`);
    return 1;
  }
  const version = Number(raw.kortix_version ?? 1);
  if (version === 3) {
    if (json) emitJson({ migrated: false, version: 3 });
    else process.stdout.write(`${status.ok(`${basename(found.path)} is already kortix_version 3`)}\n`);
    return 0;
  }
  if (version !== 2) {
    process.stderr.write(
      `${status.err(`${basename(found.path)} is kortix_version ${version}.`)}\n  ${C.dim}kortix migrate converts kortix_version 2. Run \`kortix projects upgrade\` to move a v1 kortix.toml to kortix.yaml first.${C.reset}\n`,
    );
    return 1;
  }
  // ponytail: a split manifest (`imports:`) is refused; convert per imported file when a project needs it.
  if (raw.imports !== undefined) {
    process.stderr.write(
      `${status.err('kortix migrate does not convert a manifest split with `imports:` yet.')}\n  ${C.dim}Merge the imported files into kortix.yaml, run kortix migrate, then split it again.${C.reset}\n`,
    );
    return 1;
  }

  const plan = planMigration(root, 'kortix.yaml', raw);
  if (found.format === 'toml') plan.changes.push({ path: relative(root, found.path), action: 'delete', note: 'replaced by kortix.yaml' });

  if (json) {
    emitJson({ migrated: write && plan.valid, valid: plan.valid, manifest: plan.manifest, changes: plan.changes.map(({ content: _, ...change }) => change), dropped: plan.dropped, issues: plan.issues });
  } else {
    printPlan(plan, write);
  }
  if (!plan.valid) return 1;
  if (!write) return 0;

  for (const change of plan.changes) {
    const abs = resolve(root, change.path);
    if (change.action === 'delete') rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, change.content ?? '', 'utf8');
    }
  }
  if (!json) {
    process.stdout.write(
      `\n${status.ok('Migrated to kortix_version 3')}\n` +
        `Next:\n  1. kortix validate\n  2. git add -A && git commit -m "Migrate kortix.yaml to kortix_version 3"\n  3. git push origin HEAD && kortix cr open --title "Migrate kortix.yaml to kortix_version 3"\n`,
    );
  }
  return 0;
}

function printPlan(plan: MigrationPlan, write: boolean): void {
  process.stdout.write(`kortix migrate: kortix_version 2 → 3${write ? '' : ' (preview — nothing changes; run with --write to apply)'}\n\n`);
  const width = Math.max(...plan.changes.map((change) => change.path.length)) + 2;
  for (const change of plan.changes) {
    const mark = change.action === 'delete' ? `${C.red}-${C.reset}` : `${C.yellow}~${C.reset}`;
    process.stdout.write(`  ${mark} ${change.path.padEnd(width)}${C.dim}${change.note}${C.reset}\n`);
  }
  if (plan.dropped.length > 0) {
    process.stdout.write(`\n${C.yellow}Not carried over:${C.reset}\n`);
    for (const line of plan.dropped) process.stdout.write(`  ! ${line}\n`);
  }
  process.stdout.write(`\n${C.dim}── ${join('.', 'kortix.yaml')} ──${C.reset}\n${plan.manifest}`);
  if (plan.issues.length > 0) {
    process.stdout.write(`\n${plan.valid ? 'Warnings' : `${C.red}The result does not validate${C.reset}`}:\n${formatIssues(plan.issues)}\n`);
  } else {
    process.stdout.write(`\n${status.ok('The result validates as kortix_version 3')}\n`);
  }
}
