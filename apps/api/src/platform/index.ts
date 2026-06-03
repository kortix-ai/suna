import { Hono } from 'hono';
import { apiKeysRouter } from './routes/api-keys';

const platformApp = new Hono();

platformApp.route('/api-keys', apiKeysRouter);

export { platformApp };
