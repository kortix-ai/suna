/**
 * 21 — repo-level files + git history (all platform REST, no sandbox):
 * file listing, file read, search, commit log, branches, and the diff of
 * the latest commit.
 *
 * Run (from packages/sdk):  bun run playground/git/21-files-and-git.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("files-and-git", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(projectId);

  const files = await project.files.list();
  console.log(`✓ files.list(): ${JSON.stringify(files).slice(0, 250)}…`);

  const readme = await project.files.read("README.md").catch(() => null);
  console.log(
    readme
      ? `✓ files.read('README.md'): ${readme.content.length} chars`
      : "  (no README.md at repo root — read not exercised)",
  );

  const commits = await project.git.commits();
  const list = Array.isArray(commits) ? commits : [];
  console.log(`✓ git.commits(): ${list.length} commit(s)`);

  const branches = await project.git.branches();
  console.log(`✓ git.branches(): ${JSON.stringify(branches).slice(0, 200)}`);

  const firstSha = (list[0] as { sha?: string } | undefined)?.sha;
  if (firstSha) {
    const diff = await project.git.commitDiff(firstSha);
    console.log(
      `✓ git.commitDiff(${firstSha.slice(0, 8)}): ${JSON.stringify(diff).length} bytes`,
    );
  }
});
