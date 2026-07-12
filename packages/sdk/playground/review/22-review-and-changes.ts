/**
 * 22 — human-in-the-loop surfaces: change requests, the Review Center inbox,
 * pending executor approvals, and sessions needing input. All reads.
 *
 * Run (from packages/sdk):  bun run playground/review/22-review-and-changes.ts [projectId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("review-and-changes", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(projectId);

  const changeRequests = await project.changeRequests.list();
  console.log(
    `✓ changeRequests.list(): ${JSON.stringify(changeRequests).slice(0, 250)}…`,
  );

  const review = await project.review.list();
  console.log(`✓ review.list(): ${JSON.stringify(review).slice(0, 250)}…`);

  const approvals = await project.approvals.list();
  console.log(`✓ approvals.list(): ${JSON.stringify(approvals).slice(0, 200)}`);

  const needingInput = await project.approvals.sessionsNeedingInput();
  console.log(
    `✓ approvals.sessionsNeedingInput(): ${JSON.stringify(needingInput).slice(0, 200)}`,
  );
});
