import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { healthRoutes } from './health'
import { secretsRoutes } from './secrets'
import { triggersRoutes } from './triggers'
import { messagesRoutes } from './messages'

export const kortixRoutes = new Hono()

// Health check (no auth required)
kortixRoutes.route('/health', healthRoutes)

// Apply auth middleware to all protected routes
kortixRoutes.use('/*', authMiddleware)

// Protected routes
kortixRoutes.route('/secrets', secretsRoutes)
kortixRoutes.route('/triggers', triggersRoutes)
kortixRoutes.route('/messages', messagesRoutes)
