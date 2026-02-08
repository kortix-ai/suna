import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
} from '../repositories/api-keys';
import type { AuthVariables } from '../types';

const apiKeysRouter = new Hono<{ Variables: AuthVariables }>();

// All routes require authentication
apiKeysRouter.use('/*', authMiddleware);

// Create API key schema
const createApiKeySchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

/**
 * POST /v1/api-keys - Create a new API key
 */
apiKeysRouter.post('/', async (c) => {
  const userId = c.get('userId');

  try {
    const body = await c.req.json();
    const parsed = createApiKeySchema.parse(body);

    const result = await createApiKey(
      userId,
      parsed.title,
      parsed.description,
      parsed.expires_in_days
    );

    return c.json({
      success: true,
      data: {
        key_id: result.keyId,
        public_key: result.publicKey,
        secret_key: result.secretKey, // Only shown once!
        title: result.title,
        created_at: result.createdAt,
        message: 'Save your secret key now. It will not be shown again.',
      },
    }, 201);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ success: false, error: 'Invalid request', details: err.errors }, 400);
    }
    console.error('Create API key error:', err);
    return c.json({ success: false, error: 'Failed to create API key' }, 500);
  }
});

/**
 * GET /v1/api-keys - List all API keys
 */
apiKeysRouter.get('/', async (c) => {
  const userId = c.get('userId');

  try {
    const keys = await listApiKeys(userId);

    return c.json({
      success: true,
      data: keys.map((k) => ({
        key_id: k.keyId,
        public_key: k.publicKey,
        title: k.title,
        description: k.description,
        status: k.status,
        expires_at: k.expiresAt,
        last_used_at: k.lastUsedAt,
        created_at: k.createdAt,
      })),
    });
  } catch (err) {
    console.error('List API keys error:', err);
    return c.json({ success: false, error: 'Failed to list API keys' }, 500);
  }
});

/**
 * POST /v1/api-keys/:keyId/revoke - Revoke an API key
 */
apiKeysRouter.post('/:keyId/revoke', async (c) => {
  const userId = c.get('userId');
  const keyId = c.req.param('keyId');

  try {
    const success = await revokeApiKey(userId, keyId);

    if (!success) {
      return c.json({ success: false, error: 'API key not found' }, 404);
    }

    return c.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    console.error('Revoke API key error:', err);
    return c.json({ success: false, error: 'Failed to revoke API key' }, 500);
  }
});

/**
 * DELETE /v1/api-keys/:keyId - Delete an API key
 */
apiKeysRouter.delete('/:keyId', async (c) => {
  const userId = c.get('userId');
  const keyId = c.req.param('keyId');

  try {
    const success = await deleteApiKey(userId, keyId);

    if (!success) {
      return c.json({ success: false, error: 'API key not found' }, 404);
    }

    return c.json({ success: true, message: 'API key deleted' });
  } catch (err) {
    console.error('Delete API key error:', err);
    return c.json({ success: false, error: 'Failed to delete API key' }, 500);
  }
});

export { apiKeysRouter };
