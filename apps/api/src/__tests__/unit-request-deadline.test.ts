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
  app.get('/v1/llm/chat/completions', slow);          // exempt prefix (LLM streaming)
  app.post('/v1/billing/webhooks/stripe', slow);      // exempt prefix (webhook)
  app.post('/v1/projects/x/sessions/y/wake', slow);   // exempt fragment (long sync op)
  app.post('/v1/projects/x/providers/openai/chatgpt/headless/complete', slow); // exempt fragment (OAuth device-flow long-poll)
  app.post('/v1/projects', slow);                      // exempt method+path (provision)
  app.get('/v1/projects', slow);                       // bounded — only POST is exempt
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

  it('exempts the LLM completions prefix from the deadline', async () => {
    const res = await makeApp().request('/v1/llm/chat/completions');
    expect(res.status).toBe(200);
  });

  it('exempts billing webhooks from the deadline', async () => {
    const res = await makeApp().request('/v1/billing/webhooks/stripe', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('exempts long sync sandbox ops (wake) via fragment', async () => {
    const res = await makeApp().request('/v1/projects/x/sessions/y/wake', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('exempts the ChatGPT headless OAuth device flow (long-polls past the deadline)', async () => {
    const res = await makeApp().request('/v1/projects/x/providers/openai/chatgpt/headless/complete', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('exempts POST /v1/projects (provision) but keeps GET /v1/projects bounded', async () => {
    const post = await makeApp().request('/v1/projects', { method: 'POST' });
    expect(post.status).toBe(200);
    const get = await makeApp().request('/v1/projects');
    expect(get.status).toBe(503);
  });
});
