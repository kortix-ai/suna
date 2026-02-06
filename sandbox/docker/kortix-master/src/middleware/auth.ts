import type { Context, Next } from 'hono'
import { config } from '../config'

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)

  // Validate against KORTIX_TOKEN
  if (token !== config.KORTIX_TOKEN) {
    return c.json({ error: 'Invalid token' }, 401)
  }

  // Store token in context for downstream use
  c.set('kortixToken', token)

  await next()
}
