import { Hono } from 'hono'
import { toolAllowed, type CompiledAgentSet } from '@kortix/api-contract/runtime-relay'
import type { Config } from '@/lib/config/config'
import { hostedTool, runTool, sessionEnv, toolBridgeKey } from '@/services/tools/host'
import { authorizeControl, bearerMatches } from './control-auth'

/**
 * POST /kortix/tools/:name runs a hosted tool (services/tools/host.ts) for a
 * harness that runs outside this process: OpenCode's bridge plugin calls it
 * with the box's tool-bridge key. Body: `{ args, agent, directory }`; the
 * session is this box's (`KORTIX_SESSION_ID`).
 * Answers `{ output }`, or `{ error }`: 404 unknown tool, 403 the agent may not
 * use it, 422 the tool threw.
 */
export function createToolsRouter(cfg: Config, env: NodeJS.ProcessEnv = process.env): Hono {
  const app = new Hono()

  app.post('/:name', async (c) => {
    if (!bearerMatches(c.req.header('Authorization'), toolBridgeKey(env))) {
      const { response } = authorizeControl(c, cfg, 'tools')
      if (response) return response
    }
    const name = c.req.param('name')
    const tool = hostedTool(name)
    if (!tool) return c.json({ error: `no tool named ${name} is loaded` }, 404)
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const agent = typeof body.agent === 'string' ? body.agent : ''
    if (!toolAllowed(compiledAgents(env)?.agent?.[agent]?.tools, name)) {
      return c.json({ error: `agent ${agent} may not use ${name}` }, 403)
    }
    try {
      const output = await runTool(tool, body.args as Record<string, unknown> | undefined, {
        sessionId: env.KORTIX_SESSION_ID?.trim() ?? '',
        agent,
        directory: typeof body.directory === 'string' && body.directory ? body.directory : cfg.projectTarget,
        env: sessionEnv(),
        signal: c.req.raw.signal,
      })
      return c.json({ output })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422)
    }
  })

  return app
}

function compiledAgents(env: NodeJS.ProcessEnv): Partial<CompiledAgentSet> | null {
  try {
    return JSON.parse(env.KORTIX_COMPILED_AGENT_CONFIG ?? 'null')
  } catch {
    return null
  }
}
