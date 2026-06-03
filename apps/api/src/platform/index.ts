import { Hono } from 'hono';
import { apiKeysRouter } from './routes/api-keys';
import { versionRouter } from './routes/version';

const platformApp = new Hono();

platformApp.route('/api-keys', apiKeysRouter);
platformApp.route('/sandbox/version', versionRouter);

export { platformApp };
