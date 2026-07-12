/**
 * 04 — Render a session's transcript as plain text, no React.
 *
 * The app/client protocol is ACP-first. For headless transcript rendering, use
 * the session handle's compact server transcript read instead of reaching into
 * a harness-native runtime message API.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/04-render-transcript.ts
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
  const transcript = await kortix.session(projectId, sessionId).transcript();

  if (!transcript.available) {
    console.log(`Transcript unavailable: ${transcript.reason ?? 'unknown'}`);
    return;
  }

  for (const message of transcript.messages) {
    console.log(`\n## ${message.role}`);
    if (message.text) console.log(message.text);
    for (const tool of message.tools) {
      console.log(`  [tool: ${tool.tool}${tool.status ? ` — ${tool.status}` : ''}]`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
