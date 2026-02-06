import { Hono } from 'hono'
import { SecretStore } from '../services/secret-store'

export const secretsRoutes = new Hono()
const secretStore = new SecretStore()

// List all secret keys (not values)
secretsRoutes.get('/', async (c) => {
  try {
    const keys = await secretStore.listKeys()
    return c.json({ keys })
  } catch (error: any) {
    console.error('[Kortix Master] Error listing secrets:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Get a secret by key
secretsRoutes.get('/:key', async (c) => {
  const key = c.req.param('key')

  try {
    const value = await secretStore.get(key)
    if (value === null) {
      return c.json({ error: 'Secret not found' }, 404)
    }
    return c.json({ key, value })
  } catch (error: any) {
    console.error('[Kortix Master] Error getting secret:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Set a secret
secretsRoutes.post('/:key', async (c) => {
  const key = c.req.param('key')

  try {
    const body = await c.req.json<{ value: string }>()

    if (!body.value) {
      return c.json({ error: 'Value is required' }, 400)
    }

    await secretStore.set(key, body.value)
    return c.json({ success: true, key })
  } catch (error: any) {
    console.error('[Kortix Master] Error setting secret:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Delete a secret
secretsRoutes.delete('/:key', async (c) => {
  const key = c.req.param('key')

  try {
    await secretStore.delete(key)
    return c.json({ success: true, key })
  } catch (error: any) {
    console.error('[Kortix Master] Error deleting secret:', error)
    return c.json({ error: error.message }, 500)
  }
})
