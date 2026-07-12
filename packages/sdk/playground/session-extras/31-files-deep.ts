/**
 * 31 — the rest of the 12-op session files surface: create (empty file),
 * readBlob, copy, rename, findText — everything 06/09/11/27 did not already
 * exercise. Creates under /workspace/.sdk-playground-tmp and removes it all.
 * Needs a sandbox.
 *
 * Run (from packages/sdk):  bun run playground/session-extras/31-files-deep.ts
 */
import {
  makeKortix,
  pickOrCreateSessionId,
  pickProjectId,
  retryUntilReady,
  run,
} from "../_shared";

const DIR = "/workspace/.sdk-playground-tmp";

run("files-deep", async () => {
  const kortix = makeKortix();
  const projectId = await pickProjectId(kortix);
  const sessionId = await pickOrCreateSessionId(
    kortix,
    projectId,
    "sdk files test",
  );
  const session = kortix.session(projectId, sessionId);

  console.log("readying session…");
  await retryUntilReady(() => session.ensureReady());

  await session.files.mkdir(DIR).catch(() => {});

  await session.files.create(`${DIR}/created.txt`);
  console.log("✓ create() — empty file");

  await session.files.upload(
    new Blob(["needle-for-findText\n"]),
    DIR,
    "source.txt",
  );
  console.log("✓ upload() — source file with a searchable marker");

  const blob = await session.files.readBlob(`${DIR}/source.txt`);
  console.log(`✓ readBlob(): ${blob.size} bytes, type=${blob.type || "n/a"}`);

  await session.files.copy(`${DIR}/source.txt`, `${DIR}/copy.txt`);
  const copied = await session.files.read(`${DIR}/copy.txt`);
  if (!copied.content.includes("needle-for-findText")) {
    console.error("✗ copy() content mismatch");
    process.exit(1);
  }
  console.log("✓ copy() — content survived");

  await session.files.rename(`${DIR}/copy.txt`, `${DIR}/renamed.txt`);
  const renamed = await session.files.read(`${DIR}/renamed.txt`);
  if (!renamed.content.includes("needle-for-findText")) {
    console.error("✗ rename() content mismatch");
    process.exit(1);
  }
  console.log("✓ rename() — content survived");

  const hits = await session.files.findText("needle-for-findText");
  console.log(`✓ findText(): ${JSON.stringify(hits).slice(0, 200)}`);

  for (const f of ["created.txt", "source.txt", "renamed.txt"]) {
    await session.files.remove(`${DIR}/${f}`).catch(() => {});
  }
  await session.files.remove(DIR).catch(() => {});
  console.log("✓ cleaned up — temp dir removed");
});
