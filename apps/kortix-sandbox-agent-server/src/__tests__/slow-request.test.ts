/**
 * The slow-request logger: quiet on the healthy path, one self-describing
 * line per slow request, and it never breaks the request it observes.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { slowRequestLogger } from '@/app/slow-request'
import { logger } from '@/lib/log/logger'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('slowRequestLogger', () => {
  let warns: ReturnType<typeof spyOn> | null = null
  afterEach(() => {
    warns?.mockRestore()
    warns = null
  })

  it('logs nothing when the handler is fast', async () => {
    warns = spyOn(logger, 'warn')
    const app = new Hono()
    app.use('*', slowRequestLogger(10_000))
    app.get('/fast', (c) => c.json({ ok: true }))
    const res = await app.request('/fast')
    expect(res.status).toBe(200)
    expect(warns).not.toHaveBeenCalled()
  })

  it('logs one line with wall, cpu, load and status on a slow request', async () => {
    warns = spyOn(logger, 'warn')
    const app = new Hono()
    app.use('*', slowRequestLogger(30))
    app.get('/slow', async (c) => {
      await sleep(80)
      return c.json({ ok: true })
    })
    const res = await app.request('/slow')
    expect(res.status).toBe(200)
    expect(warns).toHaveBeenCalledTimes(1)
    const [msg, ctx] = warns.mock.calls[0] as [string, Record<string, unknown>]
    expect(msg).toContain('[slow-request]')
    expect(ctx.method).toBe('GET')
    expect(ctx.route).toBe('/slow')
    expect(ctx.status).toBe(200)
    expect(Number(ctx.wallMs)).toBeGreaterThanOrEqual(80)
    expect(Number(ctx.cpuMs)).toBeGreaterThanOrEqual(0)
    expect(Number(ctx.load1)).toBeGreaterThanOrEqual(0)
  })

  it('still logs when the handler throws', async () => {
    warns = spyOn(logger, 'warn')
    const app = new Hono()
    app.use('*', slowRequestLogger(30))
    app.get('/boom', async () => {
      await sleep(60)
      throw new Error('boom')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(warns).toHaveBeenCalledTimes(1)
    const [, ctx] = warns.mock.calls[0] as [string, Record<string, unknown>]
    expect(ctx.route).toBe('/boom')
    expect(Number(ctx.wallMs)).toBeGreaterThanOrEqual(60)
  })
})
