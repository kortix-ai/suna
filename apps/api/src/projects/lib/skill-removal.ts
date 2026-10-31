import { isRecord } from '@kortix/shared/guards';

/** Only the explicitly selected skill is owned by this operation. No dependency GC.
 *  A project skill is a folder kortix.yaml registers under `skills:`. */
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
  if (!names.length) throw new Error("Not a project skill folder");
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
    files.some(
      (file) =>
        file.startsWith(`${folder}/`) &&
        file.endsWith("/SKILL.md") &&
        file !== `${folder}/SKILL.md`,
    )
  ) {
    throw new Error("Skill folder contains another skill");
  }
  const removedNames = new Set(names);
  const next = structuredClone(raw);
  next.skills = Object.fromEntries(
    Object.entries(registry).filter(([key]) => !removedNames.has(key)),
  );
  if (isRecord(next.agents)) {
    next.agents = Object.fromEntries(
      Object.entries(next.agents).map(([key, value]) => {
        const agent = isRecord(value) ? value : {};
        if (Array.isArray(agent.skills))
          agent.skills = agent.skills.filter(
            (skill) => typeof skill !== "string" || !removedNames.has(skill),
          );
        // `{ exclude }` names the skill too; a removed skill leaves it.
        else if (isRecord(agent.skills) && Array.isArray(agent.skills.exclude))
          agent.skills = {
            exclude: agent.skills.exclude.filter(
              (skill) => typeof skill !== "string" || !removedNames.has(skill),
            ),
          };
        return [key, agent];
      }),
    );
  }
  return {
    raw: next,
    deletes: files.filter((file) => file.startsWith(`${folder}/`)),
  };
}
