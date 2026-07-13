/**
 * 10 — list the project's slash commands.
 *
 * Commands are markdown prompt templates the runtime accepts at
 * `<opencode>/commands/<slug>.md` (`.kortix/opencode/commands/` here). The
 * platform surfaces repo-registered ones via `projects.detail().config`.
 *
 * Run (from packages/sdk):  bun run playground/commands/10-list-commands.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("list-commands", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);

  const detail = await kortix.projects.detail(projectId);
  const commands = detail.config.commands;

  console.log(`✓ ${commands.length} command(s):\n`);
  for (const command of commands) {
    console.log(`  /${command.name}`);
    console.log(`    path: ${command.path}`);
    if (command.description)
      console.log(`    desc: ${command.description.slice(0, 100)}`);
    console.log("");
  }

  if (commands.length === 0) {
    console.log(
      "  (none registered in the repo — 11-create-command writes one into a",
    );
    console.log(
      "   session workspace; it appears here once that change is committed)",
    );
  }
});
