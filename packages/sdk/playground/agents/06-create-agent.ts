/**
 * 06 — create an agent (config-file round-trip through the session workspace).
 *
 * An agent IS a markdown file with frontmatter. This writes
 * `.kortix/opencode/agents/sdk-test-agent.md` into the session's live
 * workspace via `session.files`, reads it back, then deletes it (set
 * KEEP_TEST_FILES=1 to keep it and see it in the web UI's Customize → Agents
 * after committing).
 *
 * NOTE: the file lives on this session's branch until committed — it will not
 * appear in `projects.detail()` (which reads the repo) until the change lands.
 * The web UI's "New agent" button drives an LLM configure-thread instead;
 * this is the deterministic equivalent.
 *
 * Run (from packages/sdk):  bun run playground/agents/06-create-agent.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

const AGENT_NAME = "sdk-test-agent";
const AGENT_DIR = "/workspace/.kortix/opencode/agents";
const AGENT_PATH = `${AGENT_DIR}/${AGENT_NAME}.md`;
const AGENT_MD = `---
description: Throwaway agent created by the SDK playground to prove agent files round-trip.
mode: subagent
---

You are ${AGENT_NAME}. Whatever the user says, reply with the single word: pong.
`;

run("create-agent", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk agent test",
  );
  const session = kortix.session(projectId, sessionId);

  console.log("readying session…");
  await retryUntilReady(() => session.ensureReady());

  await session.files.upload(
    new Blob([AGENT_MD]),
    AGENT_DIR,
    `${AGENT_NAME}.md`,
  );
  console.log(`✓ wrote ${AGENT_PATH}`);

  const readBack = await session.files.read(AGENT_PATH);
  if (readBack.content !== AGENT_MD) {
    console.error("✗ read-back content does not match what was written");
    console.error(readBack.content.slice(0, 200));
    process.exit(1);
  }
  console.log("✓ read it back — content matches byte for byte");

  if (process.env.KEEP_TEST_FILES) {
    console.log(
      `\nkept ${AGENT_PATH} (KEEP_TEST_FILES set) — commit it to register the agent`,
    );
    return;
  }

  await session.files.remove(AGENT_PATH);
  try {
    await session.files.read(AGENT_PATH);
    console.error("✗ file still readable after remove()");
    process.exit(1);
  } catch {
    console.log("✓ removed it — workspace left clean");
  }
});
