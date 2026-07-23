import { describe, expect, test } from 'bun:test';

import { ownsDefaultModelHarness, runAgents } from '../commands/agents.ts';

// `kortix agents model <agent> <model>` writes account_model_preferences —
// consulted only when the target harness does NOT own its default model
// (HARNESSES[id].ownsDefaultModel, packages/shared/src/harnesses.ts). Claude
// Code and Codex own theirs (the subscription decides), so pinning a model for
// an agent named after one of them writes a row that's provably never read.
// This used to print success anyway (the CLI's own help example demonstrated
// the bug: `kortix agents model claude anthropic/claude-opus-4-8`). Pi is
// gateway/catalog-driven since the 2026-07-21 model-resolution refactor. See
// docs/specs/2026-07-21-cli-credential-model-ux.md §1.4.

describe('ownsDefaultModelHarness', () => {
  test('flags claude and codex — both own their default model', () => {
    expect(ownsDefaultModelHarness('claude')).toBe('claude');
    expect(ownsDefaultModelHarness('codex')).toBe('codex');
  });

  test('does not flag opencode or pi — both are gateway/catalog-driven', () => {
    expect(ownsDefaultModelHarness('opencode')).toBeNull();
    expect(ownsDefaultModelHarness('pi')).toBeNull();
  });

  test('does not flag a custom agent name or undefined', () => {
    expect(ownsDefaultModelHarness('pr-reviewer')).toBeNull();
    expect(ownsDefaultModelHarness(undefined)).toBeNull();
  });
});

describe('runAgents model — refuses ownsDefaultModel harnesses before any network call', () => {
  test('rejects "claude" with exit 1 and an explanatory message, no HTTP error leaks through', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    let code: number;
    try {
      code = await runAgents(['model', 'claude', 'anthropic/claude-opus-4-8']);
    } finally {
      process.stderr.write = orig;
    }
    expect(code).toBe(1);
    const out = chunks.join('');
    expect(out).toContain('owns its own default model');
    expect(out).not.toContain('HTTP');
  });

  test('rejects "codex" the same way', async () => {
    for (const agent of ['codex']) {
      const chunks: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown) = (s: string) => {
        chunks.push(s);
        return true;
      };
      let code: number;
      try {
        code = await runAgents(['model', agent, 'anthropic/claude-opus-4-8']);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).toBe(1);
      expect(chunks.join('')).toContain(agent);
    }
  });

  test('help text no longer uses the misleading claude+anthropic example', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      chunks.push(s);
      return true;
    };
    try {
      await runAgents(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    expect(out).not.toContain('model claude anthropic/claude-opus-4-8');
  });
});
