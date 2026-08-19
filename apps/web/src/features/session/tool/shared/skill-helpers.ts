export function extractSkillContent(output: string): string {
  const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/);
  return match ? match[1].trim() : output;
}

export function extractSkillFiles(output: string): string[] {
  const filesMatch = output.match(/<skill_files>([\s\S]*?)<\/skill_files>/);
  if (!filesMatch) return [];
  const fileRegex = /<file>(.*?)<\/file>/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(filesMatch[1])) !== null) {
    files.push(m[1].trim());
  }
  return files;
}

/**
 * Every place the skill tool might have told us where the skill lives.
 *
 * The producer is the OpenCode runtime, not this repo, so its exact payload
 * cannot be read from source — which is precisely why this probes rather than
 * assumes. The first attempt keyed off `input.dir` alone, that field was absent
 * in practice, and clicking a skill silently did nothing.
 *
 * Three sources, and the tag attributes are the one the old code was already
 * hinting at: `extractSkillContent` matches `<skill_content[^>]*>`, and nobody
 * writes `[^>]*` for a tag that has no attributes.
 */
function attributeDir(output: string): string {
  const tag = output.match(/<skill_content([^>]*)>/);
  if (!tag) return '';
  for (const key of ['dir', 'directory', 'path', 'base', 'baseDir', 'base_dir']) {
    const found = tag[1].match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (found?.[1]?.trim()) return found[1].trim();
  }
  return '';
}

/** The `Base directory:` line the component already strips out of the markdown. */
function labelledDir(output: string): string {
  const match = output.match(/^\s*(?:Base directory|Directory|Skill directory)\s*:\s*(.+?)\s*$/im);
  return match ? match[1].trim() : '';
}

/**
 * The skill's base directory, from wherever the tool happened to put it.
 */
export function extractSkillBaseDir(output: string): string {
  return (attributeDir(output) || labelledDir(output)).replace(/\/+$/, '');
}

/**
 * The directory carried on the call's INPUT, under any of the names the runtime
 * might use. Same reasoning as above: probe, do not assume.
 */
export function skillInputDir(input: Record<string, unknown>): string {
  for (const key of ['dir', 'directory', 'path', 'skillPath', 'location']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\/+$/, '');
  }
  return '';
}

/**
 * Where this product installs a skill, relative to the workspace root.
 *
 * Not a guess and not a convention borrowed from upstream — it is this repo's
 * own layout, asserted in three places: `injectManagedSkills` copies each skill
 * to `<configDir>/skills/<name>/` (kortix-sandbox-agent-server), that configDir
 * falls back to `.kortix/opencode` (`resolveOpencodeConfigDir`), and the product
 * tells users the same path in prose (`entity-modal.tsx`, `use-configure-thread`).
 *
 * The panel takes workspace-relative paths — `apply-patch-tool` already hands it
 * one — so this needs no sandbox prefix.
 */
const SKILLS_DIR = '.kortix/opencode/skills';

/**
 * The directory a named skill occupies, or '' when the name cannot be trusted.
 *
 * The directory is flat, so a namespaced name contributes only its last segment.
 * A name that tries to climb out of the skills directory is refused outright
 * rather than normalised — the click's whole job is to open a skill, and there
 * is no reading of `..` under which it still does that.
 */
function conventionalSkillDir(skillName?: string): string {
  const raw = skillName?.trim().replace(/^\/+|\/+$/g, '') ?? '';
  // `SkillTool` renders `input.name || 'skill'`, so the placeholder reaches here
  // meaning "no name was sent" and must not resolve to a directory called that.
  if (!raw || raw.toLowerCase() === 'skill') return '';
  const segments = raw.split('/').map((s) => s.trim());
  // Judged over EVERY segment, not just the one that survives. Keeping the last
  // segment of `../../etc/passwd` yields `passwd` — inside the skills directory,
  // so harmless, but it quietly answers a nonsense name with a confident path.
  if (segments.some((s) => s === '..' || s === '.')) return '';
  const leaf = segments.at(-1) ?? '';
  if (!leaf) return '';
  return `${SKILLS_DIR}/${leaf}`;
}

/**
 * The file to show when a skill row is clicked, or null when there is none.
 *
 * A skill IS a document, so clicking one opens that document in the session's
 * detail panel exactly as clicking a file in a read row does. Resolution order,
 * most trustworthy first:
 *
 *   1. a location the tool actually stated — a tag attribute, a `Base
 *      directory:` line, or a directory on the call's input;
 *   2. `.kortix/opencode/skills/<name>/`, where this product installs skills;
 *   3. nothing, and only when there is no usable name either.
 *
 * (3) is now nearly unreachable, and that matters more than it looks. The row
 * takes a click ONLY when this returns a path — `BasicTool` renders a plain
 * button when handed `onClick` and a disclosure otherwise — so every earlier
 * version, which resolved from the payload alone and got '' from it, silently
 * degraded to the inline collapsible this was meant to replace.
 *
 * A `SKILL.md` listed in `<skill_files>` still names the document, since a
 * listing is the runtime being explicit; it resolves against whichever base
 * won above.
 */
export function skillDocumentPath(
  output: string,
  inputDir?: string,
  skillName?: string,
): string | null {
  const stated = inputDir?.trim().replace(/\/+$/, '') || extractSkillBaseDir(output);
  const base = stated || conventionalSkillDir(skillName);

  const listed = extractSkillFiles(output).find((f) => /(^|\/)SKILL\.md$/i.test(f));
  if (listed) {
    if (listed.startsWith('/')) return listed;
    if (base) return `${base}/${listed}`;
  }

  return base ? `${base}/SKILL.md` : null;
}
