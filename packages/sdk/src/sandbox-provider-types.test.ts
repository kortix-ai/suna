import { expect, test } from 'bun:test';
import type {
  AppHostingProvider,
  CreateProjectSessionInput,
  KortixProject,
  ProjectSessionSandbox,
  SandboxProviderName,
} from './index';
import { updateProjectSandboxProvider } from './index';

test('Platinum and the legacy Daytona fallback are accepted anywhere consumers select or observe a sandbox provider', () => {
  const platformProvider: SandboxProviderName = 'platinum';
  const runtimeProvider: ProjectSessionSandbox['provider'] = 'platinum';
  const createProvider: NonNullable<CreateProjectSessionInput['provider']> = 'platinum';
  const projectProvider: NonNullable<KortixProject['default_sandbox_provider']> = 'platinum';
  const availableProvider: NonNullable<KortixProject['available_sandbox_providers']>[number] = 'daytona';
  const updateProvider: NonNullable<Parameters<typeof updateProjectSandboxProvider>[1]> = 'daytona';
  const appProvider: AppHostingProvider = 'platinum';

  expect([
    platformProvider,
    runtimeProvider,
    createProvider,
    projectProvider,
    availableProvider,
    updateProvider,
    appProvider,
  ]).toEqual(['platinum', 'platinum', 'platinum', 'platinum', 'daytona', 'daytona', 'platinum']);
});

test('retired providers (e2b, managed, justavps) are rejected by every public provider contract', () => {
  // @ts-expect-error E2B support is discontinued
  const e2b: SandboxProviderName = 'e2b';
  // @ts-expect-error E2B support is discontinued
  const e2bRuntime: ProjectSessionSandbox['provider'] = 'e2b';
  // @ts-expect-error E2B support is discontinued
  const e2bCreate: NonNullable<CreateProjectSessionInput['provider']> = 'e2b';
  // @ts-expect-error E2B cannot be persisted as a project pin
  const e2bProjectPin: NonNullable<KortixProject['default_sandbox_provider']> = 'e2b';
  // @ts-expect-error E2B cannot be sent by the project pin mutation
  const e2bUpdate: NonNullable<Parameters<typeof updateProjectSandboxProvider>[1]> = 'e2b';
  // @ts-expect-error E2B does not host Apps
  const e2bApp: AppHostingProvider = 'e2b';
  // @ts-expect-error managed is not a sandbox provider
  const managed: SandboxProviderName = 'managed';
  // @ts-expect-error justavps is not a sandbox provider
  const justavps: NonNullable<CreateProjectSessionInput['provider']> = 'justavps';
  // @ts-expect-error retired providers cannot be persisted as project pins
  const retiredProjectPin: NonNullable<KortixProject['default_sandbox_provider']> = 'managed';
  // @ts-expect-error retired providers cannot be sent by the project pin mutation
  const retiredUpdate: NonNullable<Parameters<typeof updateProjectSandboxProvider>[1]> = 'managed';

  expect([
    e2b, e2bRuntime, e2bCreate, e2bProjectPin, e2bUpdate, e2bApp,
    managed, justavps, retiredProjectPin, retiredUpdate,
  ]).toHaveLength(10);
});
