import { NextRequest } from 'next/server';
import { getCurrentUser } from '../../../../../lib/auth';
import { getKortix } from '../../../../../lib/kortix';
import { findRunForUser } from '../../../../../lib/store';

export const runtime = 'nodejs';

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  const { sessionId } = await context.params;
  const run = await findRunForUser(user.id, sessionId);
  if (!run) return new Response('Not found', { status: 404 });

  const kortix = getKortix();
  const abort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));

      try {
        const session = kortix.sessions.handle(run.projectId, run.sessionId);
        let lastStatus = 'timeout';
        // The SDK owns the polling cadence + terminal detection; we just relay.
        for await (const snap of session.stream({ signal: abort.signal, intervalMs: 1500 })) {
          lastStatus = snap.session.status;
          send('snapshot', {
            session: snap.session,
            transcript: snap.transcript,
            stream: { attempt: snap.attempt, connected: true },
          });
        }
        send('complete', { reason: lastStatus });
      } catch (error) {
        send('snapshot', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
