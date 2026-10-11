import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ProviderListResponse, flattenModels } from '@kortix/sdk/react';

// `provider` must survive from the API catalog (`GatewayModel.provider`)
// through the SDK response type (`GatewayCatalogModel.provider`) to
// `FlatModel.provider`. It used to be recovered with an `(model as any)` cast
// because the SDK response type never declared the field; these assertions
// pin the DECLARED path.
function gatewayProviders(models: Record<string, unknown>): ProviderListResponse {
  return {
    default: { kortix: 'auto' },
    connected: ['kortix'],
    all: [{ id: 'kortix', name: 'Kortix', source: 'gateway', models }],
  } as unknown as ProviderListResponse;
}

describe('flattenModels — gateway provider pass-through (@kortix/sdk)', () => {
  test('carries `provider` for a dot-namespaced BYOK Bedrock model', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'us.anthropic.claude-opus-4-8': {
          name: 'Claude Opus 4.8',
          provider: 'amazon-bedrock',
        },
      }),
    );
    expect(flat.provider).toBe('amazon-bedrock');
    expect(flat.providerID).toBe('kortix');
    expect(flat.providerName).toBe('Kortix');
  });

  test('names a BYOK model after its real provider (OpenCode Go, not "Kortix")', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'opencode-go/glm-5.3': {
          name: 'GLM-5.3',
          provider: 'opencode-go',
          provider_name: 'OpenCode Go',
        },
      }),
    );
    expect(flat.providerID).toBe('kortix');
    expect(flat.providerName).toBe('OpenCode Go');
  });

  test('carries the models.dev passthrough fields', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'deepseek.v3.2': {
          name: 'DeepSeek V3.2',
          provider: 'amazon-bedrock',
          release_date: '2026-01-15',
          family: 'deepseek',
          description: 'A model.',
          open_weights: true,
          last_updated: '2026-07-01',
          free: true,
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'] },
          limit: { context: 128000, output: 8192 },
          cost: { input: 1, output: 2 },
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      }),
    );
    expect(flat.releaseDate).toBe('2026-01-15');
    expect(flat.family).toBe('deepseek');
    expect(flat.description).toBe('A model.');
    expect(flat.openWeights).toBe(true);
    expect(flat.lastUpdated).toBe('2026-07-01');
    expect(flat.free).toBe(true);
    expect(flat.contextWindow).toBe(128000);
    expect(flat.cost).toEqual({ input: 1, output: 2 });
    expect(flat.capabilities).toEqual({ reasoning: true, vision: true, toolcall: true });
    expect(flat.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high'] }]);
  });

  test('leaves `provider` undefined for a stale catalog that predates the field', () => {
    const [flat] = flattenModels(
      gatewayProviders({ 'us.anthropic.claude-opus-4-8': { name: 'Claude Opus 4.8' } }),
    );
    expect(flat.provider).toBeUndefined();
  });

  test('skips providers that are not connected', () => {
    expect(
      flattenModels({
        default: {},
        connected: [],
        all: [{ id: 'kortix', name: 'Kortix', source: 'gateway', models: { a: { name: 'A' } } }],
      } as unknown as ProviderListResponse),
    ).toEqual([]);
  });

  test('reads capabilities off the canonical opencode `Model` shape when present', () => {
    const [flat] = flattenModels(
      gatewayProviders({
        'gpt-5.6': {
          name: 'GPT-5.6',
          capabilities: { reasoning: true, toolcall: false, input: { image: true } },
        },
      }),
    );
    expect(flat.capabilities).toEqual({ reasoning: true, vision: true, toolcall: false });
  });
});

// Phase 4 guard (KRTX-455): the host copy of the model flattener was deleted;
// `@kortix/sdk` is its single definition. These are filesystem assertions on
// the tracked tree, so a re-introduced host definition (or a quiet re-import
// of the deleted module) fails CI instead of silently re-splitting the two
// implementations.
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dir,
  encoding: 'utf8',
}).trim();

// The pathspecs below are repo-root-relative: git grep resolves them against
// the cwd, so every grep here runs with `cwd: repoRoot`, never the test's
// directory — a wrong cwd would make a pathspec match nothing and the
// "absence" assertions pass vacuously.

/** `git grep` exits 1 on zero matches — that is the passing case here. */
function gitGrep(pattern: string, ...pathspecs: string[]): string {
  try {
    return execFileSync('git', ['grep', '-n', '-E', pattern, '--', ...pathspecs], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

describe('the host model flattener stays deleted (KRTX-455 phase 4)', () => {
  // The guard excludes itself: the assertions below quote the patterns they
  // search for, and those quotes are the only allowed occurrences.
  const notThisTest = ':(exclude)apps/web/src/features/session/model-flatten.test.ts';

  test('no file under apps/web defines `export function flattenModels`', () => {
    expect(gitGrep('export function flattenModels', 'apps/web/src', notThisTest)).toBe('');
  });

  test('no file under apps/web defines the `FlatModel` type', () => {
    expect(gitGrep('export (interface|type) FlatModel', 'apps/web/src', notThisTest)).toBe('');
  });

  test('the deleted host module is not imported again', () => {
    expect(gitGrep("from '[^']*model-flatten'", 'apps/web/src', notThisTest)).toBe('');
  });

  test('the host file itself is gone', () => {
    expect(existsSync(join(repoRoot, 'apps/web/src/features/session/model-flatten.ts'))).toBe(
      false,
    );
  });

  test('@kortix/sdk is the single definition of the flattener', () => {
    const definitions = gitGrep('export function flattenModels', 'packages/sdk/src')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(definitions).toEqual(['packages/sdk/src/core/models/model-flatten.ts']);
    expect(
      readFileSync(join(repoRoot, 'packages/sdk/src/react/model-flatten.ts'), 'utf8'),
    ).toContain("export * from '../core/models/model-flatten'");
  });
});
