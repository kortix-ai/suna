import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { agiHome, buildAgiArgs, materializeAgiHome } from '../commands/agi.ts';

test('the agent and auto-approval flags are prepended to whatever the caller passed', () => {
  expect(buildAgiArgs([])).toEqual(['--agent', 'kortix-agi', '--auto']);
  expect(buildAgiArgs(['--model', 'anthropic/claude-opus-4-8'])).toEqual([
    '--agent',
    'kortix-agi',
    '--auto',
    '--model',
    'anthropic/claude-opus-4-8',
  ]);
});

test('a leading -- separator is dropped so `kortix agi -- --mini` reaches opencode', () => {
  expect(buildAgiArgs(['--', '--mini'])).toEqual(['--agent', 'kortix-agi', '--auto', '--mini']);
  expect(buildAgiArgs(['--prompt', 'hi', '--', '--mini'])).toEqual([
    '--agent',
    'kortix-agi',
    '--auto',
    '--prompt',
    'hi',
    '--mini',
  ]);
});

test('a caller-supplied --agent or --auto is not duplicated', () => {
  expect(buildAgiArgs(['--agent', 'other'])).toEqual(['--auto', '--agent', 'other']);
  expect(buildAgiArgs(['--auto'])).toEqual(['--agent', 'kortix-agi', '--auto']);
});

test('KORTIX_HOME relocates AGI home and an explicit override wins over both', () => {
  const previous = process.env.KORTIX_HOME;
  try {
    process.env.KORTIX_HOME = '/tmp/kortix-home-fixture';
    expect(agiHome()).toBe(resolve('/tmp/kortix-home-fixture', 'agi'));
    expect(agiHome('/tmp/elsewhere')).toBe(resolve('/tmp/elsewhere'));
  } finally {
    if (previous === undefined) delete process.env.KORTIX_HOME;
    else process.env.KORTIX_HOME = previous;
  }
});

test('materializing lays down the agent, its config, and an empty scratch workspace', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'kortix-agi-'));

  const { configDir, workspace } = materializeAgiHome(home);

  expect(configDir).toBe(join(home, 'opencode'));
  expect(workspace).toBe(join(home, 'workspace'));
  expect(statSync(workspace).isDirectory()).toBe(true);
  expect(readFileSync(join(configDir, 'agents', 'kortix-agi.md'), 'utf8')).toContain(
    'You are **Kortix AGI**',
  );
  expect(readFileSync(join(configDir, 'opencode.jsonc'), 'utf8')).toContain(
    '"default_agent": "kortix-agi"',
  );
});

test('re-running restores a hand-edited agent so the bundled prompt always wins', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'kortix-agi-'));
  const { configDir } = materializeAgiHome(home);
  const agentPath = join(configDir, 'agents', 'kortix-agi.md');
  const pristine = readFileSync(agentPath, 'utf8');
  writeFileSync(agentPath, 'clobbered');

  materializeAgiHome(home);

  expect(readFileSync(agentPath, 'utf8')).toBe(pristine);
});

test('an unchanged file is left untouched so mtimes do not churn', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'kortix-agi-'));
  const { configDir } = materializeAgiHome(home);
  const agentPath = join(configDir, 'agents', 'kortix-agi.md');
  const firstWrite = statSync(agentPath).mtimeMs;

  materializeAgiHome(home);

  expect(statSync(agentPath).mtimeMs).toBe(firstWrite);
});
