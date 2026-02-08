import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { HTTPException } from 'hono/http-exception';

import { config } from './config';
import { authMiddleware } from './middleware/auth';
import { webSearch } from './routes/web-search';
import { imageSearch } from './routes/image-search';
import { llm } from './routes/llm';
import type { AppContext } from './types';

const app = new Hono<{ Variables: AppContext }>();

// === Global Middleware ===

// CORS configuration
app.use(
  '*',
  cors({
    origin: [
      'https://www.kortix.com',
      'https://kortix.com',
      'https://dev.kortix.com',
      'https://staging.kortix.com',
      ...(config.isDevelopment()
        ? ['http://localhost:3000', 'http://127.0.0.1:3000']
        : []),
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Request logging
app.use('*', logger());

// Pretty JSON in development
if (config.isDevelopment()) {
  app.use('*', prettyJSON());
}

// === Health Check (no auth) ===

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'kortix-router',
    timestamp: new Date().toISOString(),
    env: config.ENV_MODE,
  });
});

// === Protected Routes ===

// Apply auth middleware to all protected routes
app.use('/web-search/*', authMiddleware);
app.use('/image-search/*', authMiddleware);
app.use('/v1/*', authMiddleware);

// Mount route handlers
app.route('/web-search', webSearch);
app.route('/image-search', imageSearch);
app.route('/v1', llm);

// === Error Handling ===

app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err.stack);

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: true,
        message: err.message,
        status: err.status,
      },
      err.status
    );
  }

  return c.json(
    {
      error: true,
      message: 'Internal server error',
      status: 500,
    },
    500
  );
});

// === 404 Handler ===

app.notFound((c) => {
  return c.json(
    {
      error: true,
      message: 'Not found',
      status: 404,
    },
    404
  );
});

// === Start Server ===

console.log(`
╔═══════════════════════════════════════════════════════════╗
║              Kortix Router Starting                       ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${config.PORT.toString().padEnd(49)}║
║  Mode: ${config.ENV_MODE.padEnd(49)}║
╠═══════════════════════════════════════════════════════════╣
║  Search Providers:                                        ║
║    Tavily:     ${config.TAVILY_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
║    Serper:     ${config.SERPER_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
╠═══════════════════════════════════════════════════════════╣
║  LLM Providers:                                           ║
║    OpenRouter: ${config.OPENROUTER_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
║    Anthropic:  ${config.ANTHROPIC_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
║    OpenAI:     ${config.OPENAI_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
║    xAI:        ${config.XAI_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
║    Groq:       ${config.GROQ_API_KEY ? '✓ Configured'.padEnd(41) : '✗ NOT SET'.padEnd(41)}║
╚═══════════════════════════════════════════════════════════╝
`);

export default {
  port: config.PORT,
  fetch: app.fetch,
};
