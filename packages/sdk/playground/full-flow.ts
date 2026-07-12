/**
 * 09 — Everything from just a PAT: list → pick/provision project → create
 * session → ready → stream → send → wait for idle → render the reply.
 *
 * Unlike 07 (which needs KORTIX_PROJECT_ID and KORTIX_SESSION_ID exported),
 * this one bootstraps whatever is missing: it uses your first project (or
 * provisions one if the account has none) and always creates a fresh session.
 * It then waits for the runtime's `session.idle` event instead of sleeping a
 * fixed interval, so the final transcript render is complete.
 *
 * NOTE: `ensureReady()` on the fresh session provisions a REAL cloud sandbox
 * on the first run — expect the ready step to take a while.
 *
 * Run (stack up, per GETTING-STARTED.md):
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *     bun run examples/09-full-flow.ts "What files are in this repo?"
 *
 * Reuse the project/session it prints to skip provisioning next time:
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... bun run examples/09-full-flow.ts "..."
 *
 * As an npm consumer, one import line changes:
 *   import { classifyTurn, createKortix, narrowChatEvent } from '@kortix/sdk';
 *   import type { MessageWithParts } from '@kortix/sdk';
 */
import {
  ApiError,
  classifyTurn,
  createKortix,
  narrowChatEvent,
} from "../src/index";
import type { MessageWithParts } from "../src/index";

const IDLE_TIMEOUT_MS = 300_000;
const READY_DEADLINE_MS = 300_000;

/**
 * `ensureReady()` issues ONE `/start` long-poll (~30s server budget) and
 * throws a typed `RUNTIME_UNAVAILABLE` ApiError if the sandbox is still
 * provisioning when it returns — cold boots regularly take longer, and
 * retrying just re-attaches to the same server-side provision.
 */
async function retryUntilReady<T>(ensure: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await ensure();
    } catch (error) {
      const retryable =
        error instanceof ApiError && error.code === "RUNTIME_UNAVAILABLE";
      if (!retryable || Date.now() - startedAt > READY_DEADLINE_MS) throw error;
      console.log(`  still provisioning (attempt ${attempt}) — retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? "http://localhost:8008/v1";
  const apiKey = process.env.KORTIX_API_KEY;
  const prompt = process.argv[2] ?? "Say hello in one sentence.";

  if (!apiKey) {
    console.error(
      "Set KORTIX_API_KEY (mint one: user settings → API keys → Create API key).",
    );
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });

  // 1. Projects — list them, then reuse the env override, the first one, or
  //    provision a new one when the account is empty.
  const projects = await kortix.projects.list();
  console.log(`${projects.length} project(s):`);
  for (const p of projects) console.log(`  - ${p.name} (${p.project_id})`);

  let projectId = process.env.KORTIX_PROJECT_ID;
  if (!projectId) {
    if (projects.length > 0) {
      projectId = projects[0]!.project_id;
      console.log(`\nusing first project: ${projects[0]!.name}`);
    } else {
      console.log('\nno projects — provisioning "sdk-playground"…');
      const project = await kortix.projects.provision({
        name: "sdk-playground",
      });
      projectId = project.project_id;
      console.log(`provisioned ${project.name} (${projectId})`);
    }
  }

  // 2. Session — reuse the env override or create a fresh one.
  let sessionId = process.env.KORTIX_SESSION_ID;
  if (!sessionId) {
    const created = await kortix.projects.createSession(projectId, {
      name: "sdk full-flow",
    });
    sessionId = created.session_id;
    console.log(`created session ${sessionId}`);
  }

  const session = kortix.session(projectId, sessionId);

  // 3. Ready the session (boots/resumes the sandbox — slow on first run),
  //    then connect the stream BEFORE sending so no early events are missed.
  console.log("\nreadying session (first boot provisions a sandbox)…");
  const { opencodeSessionId } = await retryUntilReady(() =>
    session.ensureReady(),
  );

  let resolveIdle: () => void;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });

  const handle = await session.stream({
    onEvent: (event) => {
      const narrowed = narrowChatEvent(event);
      if (!narrowed) return;
      console.log(`· ${narrowed.type}`);
      if (narrowed.type === "session.error") {
        console.error("session error:", narrowed.error);
      }
      if (
        narrowed.type === "session.idle" &&
        narrowed.sessionID === opencodeSessionId
      ) {
        resolveIdle();
      }
    },
  });

  // 4. Send, then wait for the turn to finish (idle event, capped).
  console.log(`\nsending: ${prompt}\n`);
  await session.send(prompt);

  const timedOut = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), IDLE_TIMEOUT_MS),
    ),
  ]);
  if (timedOut)
    console.warn(
      `no session.idle within ${IDLE_TIMEOUT_MS / 1000}s — rendering anyway`,
    );
  handle.close();

  // 5. Render the whole transcript from the runtime, exactly like example 04.
  const result = await session.runtime.session.messages({
    sessionID: opencodeSessionId,
  });
  const messages = (result.data ?? []) as MessageWithParts[];
  console.log("\n--- transcript ---");
  for (const message of messages) {
    for (const part of classifyTurn(message).parts) {
      if (part.kind === "text")
        console.log(`[${message.info.role}] ${part.text}`);
    }
  }

  console.log("\nreuse this pair to skip provisioning next time:");
  console.log(`  export KORTIX_PROJECT_ID=${projectId}`);
  console.log(`  export KORTIX_SESSION_ID=${sessionId}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
