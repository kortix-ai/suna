/**
 * 07 — The whole flow, framework-free, in one file.
 *
 * createKortix → projects.list() → session(pid, sid).stream() → send() →
 * transcript(). Zero React, zero DOM, zero Node-specific API beyond
 * `process.env` and `console`.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/07-vanilla.ts "list the files here"
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
  const prompt = process.argv[2] ?? 'Say hello in one sentence.';

  if (!apiKey || !projectId || !sessionId) {
    console.error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID and KORTIX_SESSION_ID.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });

  const projects = await kortix.projects.list();
  console.log(`${projects.length} project(s); using ${projectId}`);

  const session = kortix.session(projectId, sessionId);
  const handle = await session.stream({
    onEvent: (event) => {
      const envelope = event.envelope as { method?: unknown };
      console.log(`· ${typeof envelope.method === 'string' ? envelope.method : 'response'}`);
    },
  });

  await session.send(prompt);

  await new Promise((resolve) => setTimeout(resolve, 15_000));
  handle.close();

  const transcript = await session.transcript();
  for (const message of transcript.messages) {
    if (message.text) console.log(message.text);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
