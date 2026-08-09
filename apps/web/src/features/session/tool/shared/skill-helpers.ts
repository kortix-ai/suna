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
 * The skill's base directory, as the tool itself reported it.
 *
 * `input.dir` is not dependable — the skill tool lives in the OpenCode runtime,
 * not in this repo, and a call can arrive with a name and nothing else. What the
 * output always carries is a `Base directory:` line, which is why `SkillTool`
 * has always had to strip it out of the markdown before rendering. Reading it is
 * strictly better than trusting an input field that may be absent.
 */
export function extractSkillBaseDir(output: string): string {
  const match = output.match(/^\s*Base directory:\s*(.+?)\s*$/m);
  return match ? match[1].trim().replace(/\/+$/, '') : '';
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
  const base = (inputDir?.trim() || extractSkillBaseDir(output)).replace(/\/+$/, '');

  const listed = extractSkillFiles(output).find((f) => /(^|\/)SKILL\.md$/i.test(f));
  if (listed) {
    if (listed.startsWith('/')) return listed;
    return base ? `${base}/${listed}` : null;
  }

  return base ? `${base}/SKILL.md` : null;
}
