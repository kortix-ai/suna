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
 * The file to show when a skill row is clicked, or null when there is none.
 *
 * A skill IS a document — `.opencode/skill/<name>/SKILL.md` — so clicking one
 * opens that document in the session's detail panel, exactly as clicking a file
 * in a read row does. Resolution order, most trustworthy first:
 *
 *   1. a `SKILL.md` the tool actually listed in `<skill_files>`, since that is
 *      the runtime telling us where the document is rather than us assuming;
 *   2. `<base directory>/SKILL.md`, the convention every skill in this product
 *      follows;
 *   3. nothing — and the row must then not offer a click it cannot honour.
 *
 * Relative entries resolve against the base directory, because the panel needs
 * the same absolute sandbox path a `read` call would have used.
 */
export function skillDocumentPath(output: string, inputDir?: string): string | null {
  const base = inputDir?.trim().replace(/\/+$/, '') || extractSkillBaseDir(output);

  const listed = extractSkillFiles(output).find((f) => /(^|\/)SKILL\.md$/i.test(f));
  if (listed) {
    if (listed.startsWith('/')) return listed;
    if (base) return `${base}/${listed}`;
  }

  return base ? `${base}/SKILL.md` : null;
}
