/** 04 — Render the canonical persisted ACP transcript, no React. */
import { createKortix } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;
  if (!apiKey || !projectId || !sessionId) throw new Error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_SESSION_ID');

  const session = createKortix({ backendUrl, getToken: async () => apiKey }).session(projectId, sessionId);
  const transcript = await session.transcript();
  for (const message of transcript.messages) {
    console.log(`\n## ${message.role}\n\n${message.text}`);
    for (const tool of message.tools) console.log(`\n- tool: ${tool.tool} (${tool.status ?? 'unknown'})`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
