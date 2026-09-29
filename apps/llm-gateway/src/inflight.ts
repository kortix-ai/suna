import type { Hono } from 'hono';
export function trackInflight(app: Hono) {
  // Counts requests still being served, INCLUDING a streaming response that is
  // still relaying, so `main.ts` can drain before exit instead of cutting every
  // live turn on a deploy, scale-in or Spot reclaim.
  let count = 0;
  app.use('*', async (c, next) => {
    count += 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      count -= 1;
    };
    try {
      await next();
    } catch (error) {
      done();
      throw error;
    }
    const streamed = c.res?.body;
    if (!streamed) {
      done();
      return;
    }
    // PULL-DRIVEN pass-through: one upstream read per downstream pull, so a
    // slow client throttles the provider instead of filling this process's
    // memory. (`tee()` here would do the opposite — the counting branch races
    // ahead and buffers the whole completion.)
    const reader = streamed.getReader();
    c.res = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              done();
              controller.close();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            done();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            done();
          }
        },
      }),
      c.res,
    );
  });
  return () => count;
}
