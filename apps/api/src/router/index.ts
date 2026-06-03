import { Hono } from 'hono';
import { apiKeyAuth } from '../middleware/auth';
import { webSearch } from './routes/search-web';
import { imageSearch } from './routes/search-image';
import { llm } from './routes/llm';
import { proxy } from './routes/proxy';
import { anthropic } from './routes/anthropic';

const router = new Hono();

// Search routes (apiKeyAuth)
router.use('/web-search/*', apiKeyAuth);
router.use('/image-search/*', apiKeyAuth);
router.route('/web-search', webSearch);
router.route('/image-search', imageSearch);

// LLM routes (apiKeyAuth)
router.use('/chat/*', apiKeyAuth);
router.use('/messages', apiKeyAuth);
router.use('/models', apiKeyAuth);
router.use('/models/*', apiKeyAuth);
router.route('/', llm);
router.route('/', anthropic);

// Proxy routes (auth handled internally — dual mode)
router.route('/', proxy);

export { router };
