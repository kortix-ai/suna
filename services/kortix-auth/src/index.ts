import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './config';
import { apiKeysRouter } from './routes/api-keys';
import { accountRouter } from './routes/account';
import { webhooksRouter } from './routes/webhooks';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'kortix-auth',
    timestamp: new Date().toISOString(),
  });
});

// Mount routes
app.route('/v1/api-keys', apiKeysRouter);
app.route('/v1/account', accountRouter);
app.route('/v1/webhooks', webhooksRouter);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Start server
const port = config.PORT;

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                       KORTIX AUTH                             ║
╠═══════════════════════════════════════════════════════════════╣
║  Account management, API keys, Stripe webhooks                ║
╠═══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                   ║
║    POST   /v1/api-keys           Create API key               ║
║    GET    /v1/api-keys           List API keys                ║
║    DELETE /v1/api-keys/:id       Delete API key               ║
║    POST   /v1/api-keys/:id/revoke Revoke API key              ║
║    GET    /v1/account            Account info                 ║
║    GET    /v1/account/credits    Credit balance               ║
║    POST   /v1/webhooks/stripe    Stripe webhooks              ║
╠═══════════════════════════════════════════════════════════════╣
║  Environment: ${config.ENV_MODE.padEnd(46)}║
║  Port: ${port.toString().padEnd(54)}║
║  Supabase: ${config.SUPABASE_URL ? 'CONFIGURED' : 'NOT SET'.padEnd(50)}║
║  Stripe: ${config.STRIPE_SECRET_KEY ? 'CONFIGURED' : 'NOT SET'.padEnd(52)}║
╚═══════════════════════════════════════════════════════════════╝
`);

export default {
  port,
  fetch: app.fetch,
};
