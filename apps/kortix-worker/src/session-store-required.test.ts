import { describe, expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import { buildHarness, type WorkerConfig } from './worker.ts';

function config(): WorkerConfig {
  return {
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'test',
    modelMode: 'faux',
    storeUrl: 'https://api.example.test/projects/p',
    sessionId: 'session-required',
  };
}

describe('configured durable session storage', () => {
  test.serial('fails worker boot when the durable transcript cannot be read', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => new Response('unauthorized', { status: 401 }),
      { preconnect: originalFetch.preconnect },
    );
    try {
      await expect(buildHarness(config())).rejects.toThrow(
        'session log read failed: HTTP 401',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial('fails a turn when its transcript cannot be appended', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === 'POST'
          ? new Response('forbidden', { status: 403 })
          : Response.json([]),
      { preconnect: originalFetch.preconnect },
    );
    try {
      const harness = await buildHarness(config());
      harness.faux!.setResponses([fauxAssistantMessage('answer')]);
      await expect(harness.agent.prompt('question')).rejects.toThrow(
        'session log append failed: HTTP 403',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
