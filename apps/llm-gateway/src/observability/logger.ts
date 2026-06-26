import type { GatewayLogger } from '@kortix/llm-gateway';

type Level = 'debug' | 'info' | 'warn' | 'error';

const DEBUG_ENABLED = process.env.GATEWAY_DEBUG_LOGS !== 'false';

function serialize(arg: unknown): unknown {
  if (arg instanceof Error) return { error: arg.message, stack: arg.stack };
  return arg;
}

function line(level: Level, args: unknown[]): string {
  const [first, ...rest] = args;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: typeof first === 'string' ? first : undefined,
  };
  const details = (typeof first === 'string' ? rest : args).map(serialize);
  if (details.length === 1 && details[0] && typeof details[0] === 'object') {
    Object.assign(record, details[0]);
  } else if (details.length) {
    record.details = details;
  }
  return `${JSON.stringify(record)}\n`;
}

export function createGatewayLogger(): GatewayLogger {
  const write = (level: Level, args: unknown[]) => {
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    try {
      stream.write(line(level, args));
    } catch {
      // a transient write failure must never break a request.
    }
  };

  return {
    debug: (...args) => {
      if (DEBUG_ENABLED) write('debug', args);
    },
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}
