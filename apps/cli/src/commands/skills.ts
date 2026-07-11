import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { isKortixProject } from '../project-link.ts';
import { applySkillScaffold, validateSkillName } from '../skill-scaffold.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix skills <subcommand> [options]

Author and manage the skills in this project's .kortix/opencode/skills/.

Subcommands:
  new <name>   Scaffold a new, spec-valid SKILL.md skeleton.

Options (new):
  -d, --description <text>   What the skill does + when to load it (required —
                             this is the trigger the agent matches on).
  --license <spdx>           Optional SPDX license id for the frontmatter.
  --force                    Overwrite an existing skill of the same name.
  -h, --help                 Show this help.

After scaffolding, fill in the body and open a change request:
  git add .kortix/opencode/skills/<name> && git commit -m "add <name> skill"
  git push origin HEAD && kortix cr open --title "Add <name> skill"
`;

export async function runSkills(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = argv[0];
  if (sub === 'new') {
    return runSkillsNew(argv.slice(1));
  }
  process.stderr.write(`${status.err(`unknown skills subcommand "${sub}"`)}\n\n${HELP}`);
  return 2;
}

function runSkillsNew(argv: string[]): number {
  const rest = [...argv];
  if (takeFlagBool(rest, ['-h', '--help'])) {
    process.stdout.write(HELP);
    return 0;
  }
  const force = takeFlagBool(rest, ['--force']);
  const description = takeFlagValue(rest, ['-d', '--description']);
  const license = takeFlagValue(rest, ['--license']);
  const name = rest.shift();

  if (rest.length > 0) {
    process.stderr.write(`${status.err(`unexpected argument "${rest[0]}"`)}\n\n${HELP}`);
    return 2;
  }
  if (!name) {
    process.stderr.write(`${status.err('skills new requires a <name>.')}\n\n${HELP}`);
    return 2;
  }
  const nameErr = validateSkillName(name);
  if (nameErr) {
    process.stderr.write(`${status.err(nameErr)}\n`);
    return 2;
  }
  if (!description) {
    process.stderr.write(
      `${status.err('skills new requires --description "<text>" — it is the trigger the agent uses to decide when to load the skill.')}\n`,
    );
    return 2;
  }
  if (!isKortixProject()) {
    process.stderr.write(
      `${status.err('not a Kortix project here (no .kortix/ or kortix.yaml). Run from a project root, or `kortix init` first.')}\n`,
    );
    return 2;
  }

  let result: { path: string };
  try {
    result = applySkillScaffold({ repoRoot: process.cwd(), name, description, license, force });
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  process.stdout.write(`\n${status.ok(`Wrote ${result.path}`)}\n`);
  process.stdout.write(
    `  ${C.dim}Fill in the body, then commit + open a change request:${C.reset}\n`,
  );
  process.stdout.write(`  ${C.cyan}kortix cr open --title "Add ${name} skill"${C.reset}\n\n`);
  return 0;
}
