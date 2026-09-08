import { expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';

test.each([false, true])(
  'closing a worker without custom hooks cancels its active provider request, queued=%s',
  async (queued) => {
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      systemPrompt: 'Wait.',
      modelMode: 'faux',
      sessionId: 'worker-shutdown',
      kortixToken: 'shutdown-test',
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    worker.faux!.setResponses([
      async (_context, options) => {
        entered();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return fauxAssistantMessage([], { stopReason: 'aborted' });
      },
      fauxAssistantMessage('The queued request must not run during shutdown.'),
    ]);
    const headers = { authorization: 'Bearer shutdown-test', 'content-type': 'application/json' };
    const session = (
      await (await fetch(`http://127.0.0.1:${worker.port}/session`, { headers })).json()
    )[0].id;
    const pending = fetch(`http://127.0.0.1:${worker.port}/session/${session}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Wait.' }] }),
    }).then((response) => response.json());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ready;
      if (queued) {
        const accepted = await fetch(
          `http://127.0.0.1:${worker.port}/session/${session}/prompt_async`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ parts: [{ type: 'text', text: 'Queued work.' }] }),
          },
        );
        expect(accepted.status).toBe(204);
      }
      await Promise.race([
        worker.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('worker close did not cancel the provider')),
            1000,
          );
        }),
      ]);
      expect((await pending).info.error.name).toBe('MessageAbortedError');
      expect(worker.agent.state.isStreaming).toBe(false);
      expect(worker.faux!.state.callCount).toBe(1);
    } finally {
      clearTimeout(timer);
      worker.agent.abort();
      await pending;
      worker.server.closeAllConnections();
      await worker.close();
    }
  },
);
