import { expect, test } from 'bun:test';

// Exercise the package entrypoint, including code generation and Next's CLI.
test('the default dev server starts with webpack', async () => {
  const child = Bun.spawn(['pnpm', 'dev'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, WEB_PORT: '13999', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const errors = new Response(child.stderr).text();
  try {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      if (output.includes('Ready in')) break;
    }
    expect(output).toContain('(webpack)');
    expect(output).toContain('Ready in');
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    await errors;
  }
}, 60000);
