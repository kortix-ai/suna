/**
 * `kortix projects skills <subcommand>` — the skills of ONE project, from its
 * config scan.
 *
 *   kortix projects skills ls            list the project's skills (--json)
 *   kortix projects skills get <name>    print one skill's SKILL.md in full
 *
 * Both read the project detail's `config.skills` — the same scan the web
 * Customize → Skills page and the `/` menu's skill rows render from — so what
 * this lists is what the product sees. `get` then reads the SKILL.md body
 * through the project file API.
 *
 * SCOPE — project skills only. The system skills that describe how Kortix
 * itself works stay at `kortix system-skills` (aliased `kortix skills`,
 * permanently), and the browsable optional/marketplace catalog stays at
 * `kortix marketplace list --type skill`. Three surfaces, three jobs; none of
 * them folds into another.
 */

import { emitJson, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status, stripAnsi } from '../style.ts';

/** One entry of the project detail's `config.skills` scan. */
export interface ProjectSkillSummary {
  name: string;
  /** Repository-relative path of the skill's `SKILL.md`. */
  path: string;
  description: string | null;
}

/**
 * The skill-directory segment of a scan path — the segment right before the
 * trailing `SKILL.md`. The v2 layout scans as `skills/<slug>/SKILL.md`; the
 * legacy OpenCode layout as `.opencode/skill/<slug>/SKILL.md`. A path that
 * does not name a SKILL.md (or has no folder around it) has no slug.
 */
export function slugFromSkillPath(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  if (segments[segments.length - 1] !== 'SKILL.md') return null;
  return segments[segments.length - 2];
}

/**
 * Resolve a `skills get <segment>` argument to one scanned skill: by its
 * scan name first, then by the folder the SKILL.md lives in (the URL segment
 * the web detail page and the REST layer key on). Case-insensitive on both,
 * because a skill's frontmatter name may carry capitals its folder never did.
 */
export function skillBySegment(
  skills: readonly ProjectSkillSummary[],
  segment: string,
): ProjectSkillSummary | undefined {
  const wanted = segment.toLowerCase();
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => slugFromSkillPath(skill.path)?.toLowerCase() === wanted)
  );
}

/**
 * One line per skill: the name, then its description — or, when the frontmatter
 * carries none, the path, which is still more useful than a blank cell.
 */
export function renderSkillRows(skills: readonly ProjectSkillSummary[]): string {
  if (skills.length === 0) return `${C.bold}No skills in this project yet.${C.reset}\nCreate one in the web app under Customize → Skills.\n`;
  const width = Math.max(...skills.map((skill) => skill.name.length));
  const lines = skills.map((skill) => {
    const detail = skill.description ?? stripAnsi(skill.path);
    return `  ${C.cyan}${skill.name.padEnd(width)}${C.reset}  ${stripAnsi(detail)}`;
  });
  return [`Skills in this project:`, ...lines, ''].join('\n');
}

/** The detail view: the name, where it lives, then the SKILL.md itself. */
export function renderSkillDetail(skill: ProjectSkillSummary, body: string): string {
  return [`${C.bold}${skill.name}${C.reset}`, stripAnsi(skill.path), '', body.trim(), ''].join('\n');
}

const SKILLS_HELP = help`Usage: kortix projects skills <subcommand>

Subcommands:
  ls [--json]         List the project's skills (the config scan the web
                      Customize → Skills page renders from).
  get <name|slug>     Print one skill's SKILL.md. Resolves by scan name or by
                      the skill's folder slug, case-insensitively.

Both take --project <id>; they default to the linked/default project, like
every other projects subcommand.
`;

export async function projectSkills(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(SKILLS_HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = [...argv.slice(1)];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SKILLS_HELP);
    return 0;
  }

  const json = takeFlagBool(rest, ['--json']);
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project', '-p']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext({ projectArg, hostArg });
  if (!ctx) return 1;
  const { client, projectId } = ctx;

  try {
    const detail = await client.get<{ config?: { skills?: ProjectSkillSummary[] } }>(`/projects/${projectId}/detail`);
    const skills = detail.config?.skills ?? [];

    if (sub === 'ls' || sub === 'list') {
      if (json) {
        emitJson(skills);
        return 0;
      }
      process.stdout.write(renderSkillRows(skills));
      return 0;
    }

    if (sub === 'get' || sub === 'show') {
      const segment = rest[0];
      if (!segment) {
        process.stderr.write(`${status.err('usage: kortix projects skills get <name|slug>')}\n`);
        return 2;
      }
      const skill = skillBySegment(skills, segment);
      if (!skill) {
        process.stderr.write(`${status.err(`no skill "${segment}" in this project`)}\n`);
        return 1;
      }
      const file = await client.get<{ content: string }>(
        `/projects/${projectId}/files/content?path=${encodeURIComponent(skill.path)}`,
      );
      if (json) {
        emitJson({ ...skill, body: file.content });
        return 0;
      }
      process.stdout.write(renderSkillDetail(skill, file.content));
      return 0;
    }

    process.stdout.write(SKILLS_HELP);
    return 2;
  } catch (err) {
    return surfaceApiError(err);
  }
}
