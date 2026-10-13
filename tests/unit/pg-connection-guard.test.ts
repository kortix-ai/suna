import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guard = resolve(import.meta.dirname, '../src/core/pg-connection-guard.ts');

/** Run a Bun child that emits an unhandled 'error' event, as `pg` does on a dropped connection. */
function emitUnhandled(message: string, withGuard: boolean) {
  const script = `
    ${withGuard ? `import { installPgConnectionGuard } from ${JSON.stringify(guard)}; installPgConnectionGuard();` : ''}
    import { EventEmitter } from 'node:events';
    const client = new EventEmitter();
    setTimeout(() => client.emit('error', new Error(${JSON.stringify(message)})), 0);
    setTimeout(() => { console.log('still running'); process.exit(0); }, 50);
  `;
  return spawnSync('bun', ['-e', script], { encoding: 'utf8', timeout: 20_000 });
}

describe('pg connection guard', () => {
  it('a dropped connection without the guard exits the runner', () => {
    const run = emitUnhandled('Connection terminated unexpectedly', false);
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('still running');
  });

  it('a dropped connection with the guard leaves the runner running', () => {
    const run = emitUnhandled('Connection terminated unexpectedly', true);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('still running');
    expect(run.stderr).toContain('a database connection dropped');
  });

  it('any other uncaught error still exits 1', () => {
    const run = emitUnhandled('boom', true);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('still running');
    expect(run.stderr).toContain('boom');
  });

  it('the ke2e runner installs it before any flow runs', () => {
    const ke2e = readFileSync(resolve(import.meta.dirname, '../bin/ke2e.ts'), 'utf8');
    expect(ke2e).toMatch(/^installPgConnectionGuard\(\);$/m);
    expect(ke2e.indexOf('installPgConnectionGuard();')).toBeLessThan(ke2e.indexOf('async function main'));
  });
});
