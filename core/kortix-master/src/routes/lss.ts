import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import {
  ErrorResponse,
  LssSearchResult,
  LssStatusResponse,
} from '../schemas/common'
import { z } from 'zod'

const lssRouter = new Hono()
const LSS_DIR = process.env.LSS_DIR || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/lss`

/**
 * GET /lss/search?q=<query>&k=<limit>&path=<scope>&ext=<extensions>
 *
 * Runs the `lss` CLI (Local Semantic Search) as a child process and returns
 * the raw JSON response. This provides semantic search (BM25 + embeddings)
 * over all indexed files in the workspace.
 */
lssRouter.get('/search',
  describeRoute({
    tags: ['Search'],
    summary: 'Semantic file search',
    description: 'Runs Local Semantic Search (LSS) using BM25 + embeddings over indexed workspace files. Returns ranked file hits with snippets.',
    responses: {
      200: { description: 'Search results', content: { 'application/json': { schema: resolver(z.array(LssSearchResult)) } } },
      400: { description: 'Missing query', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
      503: { description: 'LSS unavailable', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
    },
  }),
  async (c) => {
    const query = c.req.query('q')
    if (!query || !query.trim()) {
      return c.json({ error: 'Missing required parameter: q' }, 400)
    }

    const limit = parseInt(c.req.query('k') || '10', 10)
    const searchPath = c.req.query('path') || '/workspace'
    const ext = c.req.query('ext') // e.g. ".ts,.py,.md"

    // Build lss command arguments
    const args: string[] = [
      query.trim(),
      '-p', searchPath,
      '--json',
      '-k', String(Math.min(Math.max(limit, 1), 50)), // clamp 1-50
      '--no-index', // skip re-indexing for speed — lss-sync handles indexing
    ]

    // Add extension filters if provided
    if (ext) {
      for (const e of ext.split(',').map(s => s.trim()).filter(Boolean)) {
        args.push('-e', e.startsWith('.') ? e : `.${e}`)
      }
    }

    try {
      const proc = Bun.spawn(['lss', ...args], {
        env: {
          ...process.env,
          LSS_DIR,
          HOME: '/workspace',
          PATH: '/lsiopy/bin:/usr/local/bin:/usr/bin:/bin',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // 15-second timeout
      const timeout = setTimeout(() => {
        try { proc.kill() } catch {}
      }, 15_000)

      const exitCode = await proc.exited
      clearTimeout(timeout)

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      if (exitCode !== 0) {
        console.error(`[lss] Exit code ${exitCode}: ${stderr}`)
        // If lss fails, return empty results rather than erroring out
        return c.json([{ query: query.trim(), hits: [] }])
      }

      // Parse and forward the JSON response
      try {
        const data = JSON.parse(stdout)
        return c.json(data)
      } catch {
        console.error('[lss] Failed to parse JSON output:', stdout.slice(0, 500))
        return c.json([{ query: query.trim(), hits: [] }])
      }
    } catch (error) {
      console.error('[lss] Failed to spawn process:', error)
      return c.json(
        { error: 'LSS search unavailable', details: String(error) },
        503,
      )
    }
  },
)

/**
 * GET /lss/status
 *
 * Quick health check for the LSS index.
 */
lssRouter.get('/status',
  describeRoute({
    tags: ['Search'],
    summary: 'LSS index status',
    description: 'Health check for the Local Semantic Search index. Returns whether LSS is available and its status output.',
    responses: {
      200: { description: 'LSS status', content: { 'application/json': { schema: resolver(LssStatusResponse) } } },
    },
  }),
  async (c) => {
    try {
      const proc = Bun.spawn(['lss', 'status'], {
        env: {
          ...process.env,
          LSS_DIR,
          HOME: '/workspace',
          PATH: '/lsiopy/bin:/usr/local/bin:/usr/bin:/bin',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()

      return c.json({
        available: exitCode === 0,
        output: stdout.trim(),
      })
    } catch {
      return c.json({ available: false, output: 'lss binary not found' })
    }
  },
)

export default lssRouter
