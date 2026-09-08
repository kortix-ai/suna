import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isCompiledSessionRuntime,
  runtimeAllowsLiveModelChange,
  runtimeAllowsPromptOverrides,
} from '../../src/lib/session-runtime';

describe('session runtime policy', () => {
  test('recognizes every Pi marker returned by session and start metadata', () => {
    expect(isCompiledSessionRuntime({ sandbox_slug: 'pi-worker' })).toBe(true);
    expect(isCompiledSessionRuntime({ pi_worker_boot: true })).toBe(true);
    expect(
      isCompiledSessionRuntime({
        runtimeArtifact: { runtimeProfile: 'pi-worker' },
      }),
    ).toBe(true);
  });

  test('keeps ordinary sessions on the mutable runtime contract', () => {
    expect(isCompiledSessionRuntime({})).toBe(false);
    expect(isCompiledSessionRuntime(null)).toBe(false);
    expect(runtimeAllowsPromptOverrides({})).toBe(true);
    expect(runtimeAllowsLiveModelChange({})).toBe(true);
  });

  test('disables mutable prompt options and live model changes for Pi sessions', () => {
    const metadata = { pi_worker_boot: true };
    expect(runtimeAllowsPromptOverrides(metadata)).toBe(false);
    expect(runtimeAllowsLiveModelChange(metadata)).toBe(false);
  });

  test('every in-session model and agent control applies the runtime policy', () => {
    const source = (path: string) =>
      readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8');

    expect(source('components/workbench/workbench-tabs.tsx')).toContain(
      'runtimeAllowsPromptOverrides',
    );
    expect(source('components/workbench/session-header.tsx')).toContain(
      'runtimeAllowsLiveModelChange',
    );
    expect(source('components/chat/scope-bar.tsx')).toContain('runtimeAllowsLiveModelChange');
    expect(source('components/workbench/session-scope.tsx')).toContain('isCompiledSessionRuntime');
  });
});
