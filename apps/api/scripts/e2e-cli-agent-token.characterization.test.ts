import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const source = readFileSync(new URL('./e2e-cli-agent-token.ts', import.meta.url), 'utf8');
const matrixPath = new URL('./e2e-cli/command-matrix.ts', import.meta.url);
const matrix = existsSync(matrixPath) ? readFileSync(matrixPath, 'utf8') : source;

test('agent token runner preserves scenario order and result exit contract', () => {
  const order = [
    'await setup();',
    'await commandMatrix();',
    'await deniedGrantBoundary();',
    'await cleanup();',
    'log(`RESULT ${passed} passed, ${failed} failed`);',
    'process.exit(failed === 0 ? 0 : 1);',
  ];
  let cursor = 0;
  for (const step of order) {
    const position = source.indexOf(step, cursor);
    expect(position).toBeGreaterThanOrEqual(cursor);
    cursor = position + step.length;
  }
  expect(source).toContain('failed += 1;\n  log(`FATAL');
});

test('CLI matrix retains representative commands, assertions, and denied exits', () => {
  for (const name of [
    'token reports session token context',
    'projects ls fails closed for project-scoped agent token',
    'explicit empty connector scope denies a forced call',
    'connector call returns a machine-readable approval handoff',
    'gateway test sends a real model request with the agent token',
    'denied agent grant hides connector catalog',
  ]) expect(source + matrix).toContain(`'${name}'`);

  expect(matrix).toMatch(/'projects ls fails closed for project-scoped agent token'[\s\S]*?\['projects', 'ls'\][\s\S]*?code: 1/);
  expect(matrix).toMatch(/'explicit empty connector scope denies a forced call'[\s\S]*?\['connectors', 'call'[\s\S]*?code: 1/);
  expect(matrix).toMatch(/'connections finalize reports the Pipedream connection state'[\s\S]*?code: \[0, 1\]/);
  expect(matrix).toMatch(/for \(const \[name, args\] of accountOnly\)[\s\S]*?code: \[1, 2\]/);
  expect(source).toContain('const expected = Array.isArray(opts.code) ? opts.code : [opts.code ?? 0];');
  expect(source).toContain('expected.includes(result.code)');
});
