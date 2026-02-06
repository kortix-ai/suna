import { Hono } from 'hono'
import { execSync } from 'child_process'

export const healthRoutes = new Hono()

healthRoutes.get('/', (c) => {
  try {
    const output = execSync('supervisorctl status', { encoding: 'utf8', timeout: 5000 })
    const services: Record<string, string> = {}

    for (const line of output.trim().split('\n')) {
      const match = line.match(/^(\S+)\s+(\S+)/)
      if (match) {
        const [, name, state] = match
        services[name] = state.toLowerCase() === 'running' ? 'running' : 'stopped'
      }
    }

    const allRunning = Object.values(services).every(s => s === 'running')

    return c.json({
      status: allRunning ? 'healthy' : 'degraded',
      service: 'kortix-master',
      services,
      timestamp: new Date().toISOString(),
    })
  } catch (e: any) {
    return c.json({
      status: 'unhealthy',
      service: 'kortix-master',
      error: e.message,
      timestamp: new Date().toISOString(),
    }, 500)
  }
})

healthRoutes.get('/ready', (c) => {
  return c.json({ ready: true, timestamp: new Date().toISOString() })
})

healthRoutes.get('/live', (c) => {
  return c.json({ alive: true, timestamp: new Date().toISOString() })
})
