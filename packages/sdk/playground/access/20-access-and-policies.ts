/**
 * 20 — access control: project members, pending invites, access requests,
 * per-resource grants, and project policies. All reads.
 *
 * Run (from packages/sdk):  bun run playground/access/20-access-and-policies.ts [workspaceId]
 */
import { makeKortix, pickProjectId, run } from "../_shared";

run("access-and-policies", async () => {
  const kortix = makeKortix();
  const workspaceId = await pickProjectId(kortix, process.argv[2]);
  const project = kortix.project(workspaceId);

  const access = await project.access.list();
  console.log(`✓ access.list(): ${JSON.stringify(access).slice(0, 300)}…`);

  const invites = await project.access.pendingInvites();
  console.log(`✓ pendingInvites(): ${JSON.stringify(invites).slice(0, 200)}`);

  const requests = await project.access.requests();
  console.log(`✓ requests(): ${JSON.stringify(requests).slice(0, 200)}`);

  const grants = await project.access.resourceGrants.list();
  console.log(
    `✓ resourceGrants.list(): ${JSON.stringify(grants).slice(0, 200)}`,
  );

  const policies = await project.policies.list();
  console.log(`✓ policies.list(): ${JSON.stringify(policies).slice(0, 250)}…`);
});
