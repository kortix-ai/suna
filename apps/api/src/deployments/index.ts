import { Hono } from 'hono';
import { combinedAuth } from '../middleware/auth';
import { deploymentsRouter } from './routes/deployments';

const deploymentsApp = new Hono();

// Full path: /v1/deployments/*
// Combined auth: accepts both Supabase JWTs (from frontend) and kortix_ tokens (from agents).
deploymentsApp.use('/*', combinedAuth);
deploymentsApp.route('/', deploymentsRouter);

export { deploymentsApp };
