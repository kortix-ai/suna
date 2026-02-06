import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { kortixRoutes } from './routes'
import { proxyToOpenCode } from './services/proxy'
import { config } from './config'

const app = new Hono()

// Global middleware
app.use('*', logger())
app.use('*', cors())

// Kortix-specific routes (handled by Kortix Master)
app.route('/kortix', kortixRoutes)

// Proxy all other requests to OpenCode
app.all('*', async (c) => {
  return proxyToOpenCode(c)
})

console.log(`[Kortix Master] Starting on port ${config.PORT}`)
console.log(`[Kortix Master] Proxying to OpenCode at ${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`)

export default {
  port: config.PORT,
  fetch: app.fetch,
}
