/**
 * 08 — list the project's skills and read one SKILL.md straight from the repo.
 *
 * `readProjectFile` is a platform REST read (repo content) — no sandbox needed.
 *
 * Run (from packages/sdk):  bun run playground/skills/08-list-skills.ts [projectId]
 */
import { readProjectFile } from "../../src/index";
import { makeKortix, pickProjectId, run } from "../_shared";

run("list-skills", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const detail = await kortix.projects.detail(projectId);
  const skills = detail.config.skills;

  console.log(`✓ ${skills.length} skill(s):\n`);
  for (const skill of skills) {
    console.log(`  ${skill.name}`);
    console.log(`    path: ${skill.path}`);
    if (skill.description)
      console.log(`    desc: ${skill.description.slice(0, 100)}`);
    console.log("");
  }

  if (skills.length > 0) {
    const first = skills[0]!;
    const file = await readProjectFile(projectId, first.path);
    console.log(`✓ readProjectFile('${first.path}') — first 300 chars:\n`);
    console.log(file.content.slice(0, 300));
  }
});
