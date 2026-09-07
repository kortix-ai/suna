import { expect, test } from 'bun:test';
import { startWorker } from './worker.ts';

test('the model receives current tool capabilities after an older compiled prompt', async () => {
  const prompt = 'Review changes carefully. You have four tools and no skill loader.';
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: prompt,
    modelMode: 'faux',
    sessionId: 'tool-guidance',
  });
  try {
    const effective = worker.agent.state.systemPrompt;
    expect(effective.startsWith(prompt)).toBe(true);
    expect(effective).toContain('Use websearch for current information');
    expect(effective).toContain('Registered tools: bash, read, write, edit, glob, grep, question, todowrite, todoread, websearch, skill.');
    expect(effective).toContain('Use question to collect answers through the interactive question UI.');
    expect(effective).toContain('Call tools normally; the runtime requests permission when the configured policy requires it.');
    expect(effective).toContain('Keep the agent-specific restrictions on tool use.');
  } finally {
    worker.server.closeAllConnections();
    await worker.close();
  }
});
