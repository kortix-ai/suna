/**
 * 06 — Workspace files (session-scoped) + project secrets.
 *
 * `session(pid, sid).files` is the same 12-op files surface as the top-level
 * `files` export, but bound to THIS session's own resolved runtime instead of
 * whichever sandbox happens to be globally "active" — the right choice for a
 * server juggling multiple concurrent sessions (see `03-server-wrapper.ts`).
 * `project(id).secrets.upsert` writes an env var a session's agent reads at
 * runtime (e.g. an API key the agent should have, but the end user should
 * never see again after write).
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/06-files-and-secrets.ts
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 */
import { createKortix } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;

  if (!apiKey || !projectId || !sessionId) {
    console.error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_SESSION_ID and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const session = kortix.session(projectId, sessionId);

  // Every `session.files.*` call auto-provisions the runtime via
  // `ensureReady()` internally — no explicit `ensureReady()` call needed here.
  const workspace = await session.files.list('/workspace');
  console.log(`/workspace has ${workspace.length} entr(y/ies):`);
  for (const entry of workspace.slice(0, 20)) {
    console.log(`  ${entry.type === 'directory' ? 'd' : '-'} ${entry.name}`);
  }

  const firstFile = workspace.find((e) => e.type === 'file');
  if (firstFile) {
    const content = await session.files.read(`/workspace/${firstFile.name}`);
    console.log(`\nFirst chars of ${firstFile.name} (${content.type}):\n${content.content.slice(0, 200)}`);
  }

  // Project secret — scoped to the project, available to every session's
  // agent (not just this one) unless further restricted via `agentScope`.
  await kortix.project(projectId).secrets.upsert({
    name: 'EXAMPLE_API_KEY',
    value: 'sk-example-do-not-use',
  });
  const secrets = await kortix.project(projectId).secrets.list();
  console.log(
    `\nProject now has ${secrets.items.length} secret(s): ${secrets.items.map((s) => s.name).join(', ')}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
