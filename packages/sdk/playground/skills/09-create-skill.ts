/**
 * 09 — create a skill (dir + SKILL.md round-trip through the session workspace).
 *
 * A skill is a directory holding a SKILL.md with name/description frontmatter
 * (`.kortix/opencode/skills/<name>/SKILL.md` in this repo layout). Same
 * deterministic write→read→delete cycle as 06-create-agent; the web UI's
 * "New skill" drives an LLM configure-thread instead. Set KEEP_TEST_FILES=1
 * to keep the file (commit it to register the skill).
 *
 * Run (from packages/sdk):  bun run playground/skills/09-create-skill.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

const SKILL_NAME = "sdk-test-skill";
const SKILL_DIR = `/workspace/.kortix/opencode/skills/${SKILL_NAME}`;
const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;
const SKILL_MD = `---
name: ${SKILL_NAME}
description: Throwaway skill created by the SDK playground to prove skill files round-trip.
---

# ${SKILL_NAME}

When this skill is invoked, reply with the single word: loaded.
`;

run("create-skill", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk skill test",
  );
  const session = kortix.session(projectId, sessionId);

  console.log("readying session…");
  await retryUntilReady(() => session.ensureReady());

  await session.files.mkdir(SKILL_DIR);
  await session.files.upload(new Blob([SKILL_MD]), SKILL_DIR, "SKILL.md");
  console.log(`✓ wrote ${SKILL_PATH}`);

  const readBack = await session.files.read(SKILL_PATH);
  if (readBack.content !== SKILL_MD) {
    console.error("✗ read-back content does not match what was written");
    process.exit(1);
  }
  console.log("✓ read it back — content matches byte for byte");

  if (process.env.KEEP_TEST_FILES) {
    console.log(
      `\nkept ${SKILL_PATH} (KEEP_TEST_FILES set) — commit it to register the skill`,
    );
    return;
  }

  await session.files.remove(SKILL_PATH);
  await session.files.remove(SKILL_DIR).catch(() => {});
  try {
    await session.files.read(SKILL_PATH);
    console.error("✗ file still readable after remove()");
    process.exit(1);
  } catch {
    console.log("✓ removed it — workspace left clean");
  }
});
