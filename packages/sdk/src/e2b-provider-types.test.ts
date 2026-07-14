import { expect, test } from 'bun:test';
import type {
  CreateProjectSessionInput,
  KortixProject,
  ProjectSessionSandbox,
  SandboxProviderName,
} from './index';
import { updateProjectSandboxProvider } from './index';

test('E2B is accepted anywhere consumers select or observe a sandbox provider', () => {
  const platformProvider: SandboxProviderName = 'e2b';
  const runtimeProvider: ProjectSessionSandbox['provider'] = 'e2b';
  const createProvider: NonNullable<CreateProjectSessionInput['provider']> = 'e2b';
  const projectProvider: NonNullable<KortixProject['default_sandbox_provider']> = 'e2b';
  const availableProvider: NonNullable<KortixProject['available_sandbox_providers']>[number] = 'e2b';
  const updateProvider: NonNullable<Parameters<typeof updateProjectSandboxProvider>[1]> = 'e2b';

  expect([
    platformProvider,
    runtimeProvider,
    createProvider,
    projectProvider,
    availableProvider,
    updateProvider,
  ]).toEqual(['e2b', 'e2b', 'e2b', 'e2b', 'e2b', 'e2b']);
});

test('retired providers are rejected by every public provider contract', () => {
  // @ts-expect-error managed is not a sandbox provider
  const managed: SandboxProviderName = 'managed';
  // @ts-expect-error local_docker is not a sandbox provider
  const localDocker: ProjectSessionSandbox['provider'] = 'local_docker';
  // @ts-expect-error justavps is not a sandbox provider
  const justavps: NonNullable<CreateProjectSessionInput['provider']> = 'justavps';
  // @ts-expect-error retired providers cannot be persisted as project pins
  const retiredProjectPin: NonNullable<KortixProject['default_sandbox_provider']> = 'managed';
  // @ts-expect-error retired providers cannot be sent by the project pin mutation
  const retiredUpdate: NonNullable<Parameters<typeof updateProjectSandboxProvider>[1]> = 'local_docker';

  expect([managed, localDocker, justavps, retiredProjectPin, retiredUpdate]).toHaveLength(5);
});
