/**
 * The one definition of "a skill folder" — shared by `build.ts` (scanning a
 * Kortix repo's `<configDir>/skills`) and `fetch.ts` (scanning a foreign GitHub
 * repo for the SKILL.md standard). Both need the identical grouping rule:
 * a `SKILL.md` marks a skill; its name is the parent dir's leaf; its files are
 * that dir's whole subtree, targeted under `@skills/<name>/<rel>`.
 *
 * This is pure (just path arithmetic) — callers attach frontmatter + content.
 */

export interface SkillGroupFile {
  /** Path in the caller's path space (e.g. repo-relative). */
  path: string;
  /** Path within the skill dir, for `@skills/<name>/<rel>`. */
  rel: string;
}

export interface SkillGroup {
  /** Leaf dir name (raw — caller decides casing). */
  name: string;
  /** Skill dir relative to `rootPrefix` (e.g. `GROUP/pdf` or `pdf`). */
  relDir: string;
  /** The SKILL.md path (caller path space). */
  skillMd: string;
  files: SkillGroupFile[];
}

/**
 * Group a flat file list into skills under `rootPrefix` (e.g.
 * `.kortix/opencode/skills` or a sparse subdir). Returns one group per
 * `**​/SKILL.md`, each with its sibling files.
 */
export function groupSkillFiles(paths: string[], rootPrefix: string): SkillGroup[] {
  const prefix = rootPrefix ? `${rootPrefix.replace(/\/+$/, '')}/` : '';
  const skillMds = paths
    .filter((p) => p.startsWith(prefix) && /(^|\/)SKILL\.md$/.test(p))
    .sort();

  const seen = new Set<string>();
  const out: SkillGroup[] = [];
  for (const skillMd of skillMds) {
    const skillDir = skillMd.slice(0, skillMd.length - '/SKILL.md'.length);
    if (seen.has(skillDir)) continue;
    seen.add(skillDir);
    const relDir = skillDir.slice(prefix.length);
    const name = relDir.split('/').pop() ?? '';
    if (!name) continue;
    const files = paths
      .filter((p) => p === skillMd || (skillDir && p.startsWith(`${skillDir}/`)))
      .sort()
      .map((p) => ({ path: p, rel: p === skillMd ? 'SKILL.md' : p.slice(skillDir.length + 1) }));
    out.push({ name, relDir, skillMd, files });
  }
  return out;
}
