import { expect, test } from 'bun:test';
import { deriveSessionWorkspacePhase } from './use-session-workspace';

test('one-box sessions use their control runtime without provisioning an environment', () => {
  expect(
    deriveSessionWorkspacePhase({
      enabled: true,
      dataRuntimeKind: 'worker',
      workspaceUrl: 'https://worker.example',
      environmentStatus: null,
      hasError: false,
    }),
  ).toBe('ready');
});

test('Pi sessions remain resolving until the environment has an address', () => {
  expect(
    deriveSessionWorkspacePhase({
      enabled: true,
      dataRuntimeKind: 'environment',
      workspaceUrl: null,
      environmentStatus: 'active',
      hasError: false,
    }),
  ).toBe('resolving');
});

test('Pi environment failures are explicit', () => {
  expect(
    deriveSessionWorkspacePhase({
      enabled: true,
      dataRuntimeKind: 'environment',
      workspaceUrl: null,
      environmentStatus: null,
      hasError: true,
    }),
  ).toBe('error');
});
