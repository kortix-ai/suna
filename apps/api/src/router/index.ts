import { Hono } from 'hono';
import { config } from '../config';
import { apiKeyAuth } from '../middleware/auth';
import { webSearch } from './routes/search-web';
import { imageSearch } from './routes/search-image';
import { llm } from './routes/llm';
import { sessionLlm } from './routes/session-llm';
import { proxy } from './routes/proxy';
import { anthropic } from './routes/anthropic';

const router = new Hono();

// Health checks (no auth)
router.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'kortix-router',
    timestamp: new Date().toISOString(),
    billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
  });
});

// Search routes (apiKeyAuth)
router.use('/web-search/*', apiKeyAuth);
router.use('/image-search/*', apiKeyAuth);
router.route('/web-search', webSearch);
router.route('/image-search', imageSearch);

// LLM routes (apiKeyAuth)
router.route('/llm', sessionLlm);
router.use('/chat/*', apiKeyAuth);
router.use('/messages', apiKeyAuth);
router.use('/models', apiKeyAuth);
router.use('/models/*', apiKeyAuth);
router.route('/', llm);
router.route('/', anthropic);

// Proxy routes (auth handled internally — dual mode)
router.route('/', proxy);

export { router };
