/** 02 — Send a prompt and watch raw ACP events, framework-free. */
import { createKortix } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;
  const prompt = process.argv[2] ?? 'Say hello in one sentence.';
  if (!apiKey || !projectId || !sessionId) throw new Error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_SESSION_ID');

  const session = createKortix({ backendUrl, getToken: async () => apiKey }).session(projectId, sessionId);
  await session.ensureReady();
  const handle = await session.stream({
    onEvent: ({ envelope }) => {
      if (!('method' in envelope) || envelope.method !== 'session/update') return;
      const update = (envelope.params as any)?.update;
      const text = update?.content?.type === 'text' ? update.content.text : '';
      if (text) process.stdout.write(text);
    },
    onError: (error) => console.error('\n[ACP stream error]', error),
  });
  console.log(`> ${prompt}\n`);
  await session.send(prompt);
  handle.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
