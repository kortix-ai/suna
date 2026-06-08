import { describe, expect, it, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// DEADLINE_MS is read from env at module load, and static imports are hoisted
// above top-level code — so we must set the env var and then *dynamically*
// import the middleware, otherwise it captures the default 28s budget.
let requestDeadline: typeof import('../middleware/request-deadline').requestDeadline;

beforeAll(async () => {
  process.env.REQUEST_DEADLINE_MS = '50';
  ({ requestDeadline } = await import('../middleware/request-deadline'));
});

function makeApp() {
  const app = new Hono();
  app.use('/v1/*', (c, next) => requestDeadline(c, next));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: String(err) }, 500);
  });
  const slow = async (c: any) => {
    await new Promise((r) => setTimeout(r, 500)); // exceeds the 50ms deadline
    return c.json({ ok: true });
  };
  app.get('/v1/projects/x/change-requests', slow); // bounded
  app.get('/v1/p/sandbox/3000/index.html', slow);  // exempt prefix
  app.get('/v1/projects/x/turn-stream', slow);      // exempt fragment
  app.get('/v1/router/chat/completions', slow);      // exempt prefix
  app.get('/v1/projects/x/fast', (c) => c.json({ ok: true })); // bounded, fast
  return app;
}

describe('requestDeadline', () => {
  it('returns 503 when a non-streaming request exceeds the deadline', async () => {
    const res = await makeApp().request('/v1/projects/x/change-requests');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('deadline');
  });

  it('lets a fast non-streaming request through', async () => {
    const res = await makeApp().request('/v1/projects/x/fast');
    expect(res.status).toBe(200);
  });

  it('exempts the sandbox preview proxy prefix from the deadline', async () => {
    const res = await makeApp().request('/v1/p/sandbox/3000/index.html');
    expect(res.status).toBe(200); // would be 503 if bounded
  });

  it('exempts streaming fragments (turn-stream) from the deadline', async () => {
    const res = await makeApp().request('/v1/projects/x/turn-stream');
    expect(res.status).toBe(200);
  });

  it('exempts the LLM router prefix from the deadline', async () => {
    const res = await makeApp().request('/v1/router/chat/completions');
    expect(res.status).toBe(200);
  });

  it('exempts SSE requests via the Accept header', async () => {
    const res = await makeApp().request('/v1/projects/x/change-requests', {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200); // exempted despite being slow
  });
});
