/**
 * 11 — create a slash command (file round-trip through the session workspace).
 *
 * Same deterministic write→read→delete cycle as 06/09. Set KEEP_TEST_FILES=1
 * to keep it (commit it to register `/sdk-test-command`).
 *
 * Run (from packages/sdk):  bun run playground/commands/11-create-command.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

const COMMAND_NAME = "sdk-test-command";
const COMMAND_DIR = "/workspace/.kortix/opencode/commands";
const COMMAND_PATH = `${COMMAND_DIR}/${COMMAND_NAME}.md`;
const COMMAND_MD = `---
description: Throwaway command created by the SDK playground to prove command files round-trip.
---

Summarize the repository README in one sentence.
`;

run("create-command", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk command test",
  );
  const session = kortix.session(projectId, sessionId);

  console.log("readying session…");
  await retryUntilReady(() => session.ensureReady());

  await session.files.mkdir(COMMAND_DIR).catch(() => {});
  await session.files.upload(
    new Blob([COMMAND_MD]),
    COMMAND_DIR,
    `${COMMAND_NAME}.md`,
  );
  console.log(`✓ wrote ${COMMAND_PATH}`);

  const readBack = await session.files.read(COMMAND_PATH);
  if (readBack.content !== COMMAND_MD) {
    console.error("✗ read-back content does not match what was written");
    process.exit(1);
  }
  console.log("✓ read it back — content matches byte for byte");

  if (process.env.KEEP_TEST_FILES) {
    console.log(
      `\nkept ${COMMAND_PATH} (KEEP_TEST_FILES set) — commit it to register /${COMMAND_NAME}`,
    );
    return;
  }

  await session.files.remove(COMMAND_PATH);
  try {
    await session.files.read(COMMAND_PATH);
    console.error("✗ file still readable after remove()");
    process.exit(1);
  } catch {
    console.log("✓ removed it — workspace left clean");
  }
});
