import { skillDirs } from "@kortix/manifest-schema";
import { isRecord } from '@kortix/shared/guards';

/** Only the explicitly selected skill is owned by this operation. No dependency GC. */
export function planSkillRemoval(
  raw: Record<string, unknown>,
  files: string[],
  folder: string,
) {
  const parts = folder.split("/");
  const name = parts.at(-1) ?? "";
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    folder.includes("\\") ||
    name.startsWith("kortix-")
  ) {
    throw new Error("Select a canonical project skill folder");
  }
  const registry = (isRecord(raw.skills) ? raw.skills : {});
  const names = Object.entries(registry)
    .filter(([, path]) => path === folder)
    .map(([key]) => key);
  const roots = skillDirs(raw);
  if (!names.length && !roots.some((root) => folder === `${root}/${name}`)) {
    throw new Error("Not a project skill folder");
  }
  if (!files.includes(`${folder}/SKILL.md`))
    throw new Error("Project skill not found");
  if (
    Object.values(registry).some(
      (path) =>
        typeof path === "string" &&
        path !== folder &&
        (path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`)),
    )
  ) {
    throw new Error("Skill folder overlaps another registered skill");
  }
  if (
    roots.some(
      (root) =>
        `${root}/${name}` !== folder &&
        files.includes(`${root}/${name}/SKILL.md`),
    )
  ) {
    throw new Error("Skill name is shared by multiple folders");
  }
  if (
    files.some(
      (file) =>
        file.startsWith(`${folder}/`) &&
        file.endsWith("/SKILL.md") &&
        file !== `${folder}/SKILL.md`,
    )
  ) {
    throw new Error("Skill folder contains another skill");
  }
  const removedNames = new Set([...names, name]);
  const next = structuredClone(raw);
  if (names.length)
    next.skills = Object.fromEntries(
      Object.entries(registry).filter(([key]) => !removedNames.has(key)),
    );
  if (Array.isArray(next.agents))
    throw new Error("Legacy array agents are not supported for removal");
  if (next.agents) {
    next.agents = Object.fromEntries(
      Object.entries((isRecord(next.agents) ? next.agents : {})).map(([key, value]) => {
        const agent = isRecord(value) ? value : {};
        if (Array.isArray(agent.skills))
          agent.skills = agent.skills.filter(
            (skill) => typeof skill !== "string" || !removedNames.has(skill),
          );
        return [key, agent];
      }),
    );
  }
  return {
    raw: next,
    deletes: files.filter((file) => file.startsWith(`${folder}/`)),
  };
}
