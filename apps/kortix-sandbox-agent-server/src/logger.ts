/**
 * Structured stdout logger. Keeps output greppable but lets us attach context.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, msg: string, ctx?: Record<string, unknown> | unknown) {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  }
  if (ctx !== undefined) {
    if (ctx instanceof Error) {
      line.error = { name: ctx.name, message: ctx.message, stack: ctx.stack }
    } else if (typeof ctx === 'object' && ctx !== null) {
      Object.assign(line, ctx)
    } else {
      line.ctx = ctx
    }
  }
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  sink.write(JSON.stringify(line) + '\n')
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown> | unknown) => emit('error', msg, ctx),
}
