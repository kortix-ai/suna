/**
 * 27 — everything else a session handle can do: REST lifecycle reads (get,
 * transcript, audit trail, public shares, preview candidates), health, and —
 * after readying the runtime — previewUrl/proxyUrl plus the file-search and
 * git-status surfaces. Needs a sandbox.
 *
 * Uses KORTIX_SESSION_ID if set, otherwise creates a fresh session.
 *
 * Run (from packages/sdk):  bun run playground/session-extras/27-session-lifecycle.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

run("session-lifecycle", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk lifecycle test",
  );
  const session = kortix.session(projectId, sessionId);

  const row = await session.get();
  console.log(`✓ get(): status=${(row as { status?: string } | null)?.status}`);

  const health = await session.health();
  console.log(
    `✓ health() before ready: ${JSON.stringify(health).slice(0, 120)} (graceful, no throw)`,
  );

  console.log("readying session…");
  await retryUntilReady(() => session.ensureReady());

  const preview = session.previewUrl(3000);
  console.log(`✓ previewUrl(3000): ${preview}`);

  const proxied = session.proxyUrl("http://localhost:8080/health");
  console.log(`✓ proxyUrl(localhost:8080): ${proxied}`);

  const healthy = await session.health();
  console.log(
    `✓ health() after ready: ${JSON.stringify(healthy).slice(0, 120)}`,
  );

  const transcript = await session.transcript();
  console.log(`✓ transcript(): ${JSON.stringify(transcript).slice(0, 200)}…`);

  const audit = await session.audit(10);
  console.log(`✓ audit(10): ${JSON.stringify(audit).slice(0, 200)}`);

  const shares = await session.publicShares.list();
  console.log(`✓ publicShares.list(): ${JSON.stringify(shares).slice(0, 200)}`);

  const previews = await session.previews();
  console.log(`✓ previews(): ${JSON.stringify(previews).slice(0, 200)}`);

  const found = await session.files.findFiles("README", { limit: 3 });
  console.log(
    `✓ files.findFiles('README'): ${JSON.stringify(found).slice(0, 200)}`,
  );

  const status = await session.files.status();
  console.log(`✓ files.status(): ${JSON.stringify(status).slice(0, 200)}`);

  process.exit(0);
});
