/**
 * 35 — public sharing: a session public-share create→list→revoke round-trip,
 * plus the sandbox-scoped share list for this session's sandbox. Cleans up
 * after itself (no share left published). Needs a sandbox.
 *
 * Run (from packages/sdk):  bun run playground/session-extras/35-shares.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

run("shares", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk shares test",
  );
  const session = kortix.session(projectId, sessionId);

  console.log("readying session…");
  const { sandboxId } = await retryUntilReady(() => session.ensureReady());

  const before = await session.publicShares.list();
  console.log(
    `✓ publicShares.list() before: ${JSON.stringify(before).slice(0, 150)}`,
  );

  const created = await session.publicShares.create({
    preview: { port: 3000, label: "sdk test" },
  });
  const shareId = (created as { share?: { share_id?: string } }).share
    ?.share_id;
  console.log(
    `✓ publicShares.create(port 3000): ${JSON.stringify(created).slice(0, 200)}`,
  );

  const during = await session.publicShares.list();
  console.log(`✓ list() during: ${JSON.stringify(during).slice(0, 200)}`);

  if (shareId) {
    await session.publicShares.revoke(shareId);
    console.log("✓ revoke() — share removed, nothing left published");
  } else {
    console.warn(
      "⚠ could not extract share_id from create() response — revoke skipped, check the web UI",
    );
  }

  try {
    const sandboxShares = await kortix.sandboxShares.list(sandboxId);
    console.log(
      `✓ sandboxShares.list(${sandboxId.slice(0, 8)}…): ${JSON.stringify(sandboxShares).slice(0, 200)}`,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 502) {
      console.log(
        "⚠ sandboxShares.list(): 502 from /p/share on the local stack — known platform issue (see PROGRESS.md); the SDK surfaced it correctly as a typed ApiError",
      );
      return;
    }
    throw error;
  }
});
