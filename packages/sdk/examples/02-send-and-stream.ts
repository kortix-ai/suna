/**
 * 02 — Send a prompt and watch it stream, framework-free.
 *
 * `session(pid, sid).ensureReady()` provisions/resumes the session's sandbox
 * (long-polls until the runtime is up) and resolves its OpenCode session id.
 * `.send()` does that for you internally, but calling `ensureReady()` first
 * lets `.stream()` connect BEFORE the prompt goes out, so no early events are
 * missed. `narrowChatEvent` reshapes the raw ~50-variant wire union down to
 * the dozen events a chat UI actually cares about (message/part updates,
 * status, questions, permissions) — the same narrowing `@kortix/sdk/react`'s
 * `useOpenCodeEventStream` does internally.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/02-send-and-stream.ts "What files are in this repo?"
 *
 * As an npm consumer:
 *   import { createKortix, narrowChatEvent } from '@kortix/sdk';
 */
import { createKortix, narrowChatEvent } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;
  const prompt = process.argv[2] ?? 'Say hello in one sentence.';

  if (!apiKey || !projectId || !sessionId) {
    console.error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_SESSION_ID and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const session = kortix.session(projectId, sessionId);

  // Resolve the runtime once so `.stream()` is connected before `.send()`
  // fires — otherwise the first few events could arrive before we're
  // listening.
  await session.ensureReady();

  const handle = await session.stream({
    onEvent: (event) => {
      const chatEvent = narrowChatEvent(event);
      if (!chatEvent) return; // not chat-relevant (lsp/pty/worktree/...)
      switch (chatEvent.type) {
        case 'message.part.updated':
          if (chatEvent.part.type === 'text') {
            process.stdout.write((chatEvent.part as { text?: string }).text ?? '');
          }
          break;
        case 'session.idle':
          console.log('\n\n[session idle — turn complete]');
          break;
        case 'session.error':
          console.error('\n[session error]', chatEvent.error);
          break;
        default:
          break;
      }
    },
    onGapRehydrate: (gapMs) => console.warn(`\n[reconnected after a ${gapMs}ms gap]`),
  });

  console.log(`> ${prompt}\n`);
  await session.send(prompt);

  // Give the stream a few seconds to flush the turn's events, then close.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
