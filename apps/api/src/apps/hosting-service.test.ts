import { describe, expect, test } from 'bun:test';
import type { SandboxProviderName } from '../config';
import {
  AppHostingService,
  appRuntimeTarget,
  hostingSelectionForTarget,
} from './hosting-service';

describe('AppHostingService', () => {
  test('keeps managed-container targets out of the sandbox provider registry', () => {
    const target = appRuntimeTarget({
      hostingType: 'managed_container',
      provider: 'aws_lightsail',
      runtimeId: 'runtime-1',
      externalId: 'service-1',
    });

    expect(hostingSelectionForTarget(target)).toEqual({
      type: 'managed_container',
      provider: 'aws_lightsail',
    });
  });

  test('queries the selected backend for runtime status', async () => {
    const calls: string[] = [];
    const service = new AppHostingService({
      sandbox: {
        providerStatus: async (provider: SandboxProviderName, externalId: string) => {
          calls.push(`sandbox:${provider}:${externalId}`);
          return 'running';
        },
      } as never,
      lightsail: {
        status: async (externalId: string) => {
          calls.push(`lightsail:${externalId}`);
          return 'stopped';
        },
      } as never,
    });

    await expect(service.status(appRuntimeTarget({
      hostingType: 'sandbox',
      provider: 'platinum',
      runtimeId: 'runtime-1',
      externalId: 'box-1',
    }))).resolves.toBe('running');
    await expect(service.status(appRuntimeTarget({
      hostingType: 'managed_container',
      provider: 'aws_lightsail',
      runtimeId: 'runtime-2',
      externalId: 'service-2',
    }))).resolves.toBe('stopped');
    expect(calls).toEqual([
      'sandbox:platinum:box-1',
      'lightsail:service-2',
    ]);
  });

  test('validates the exact Lightsail power before returning a billable machine', () => {
    const service = new AppHostingService({ sandbox: {} as never, lightsail: {} as never });
    expect(service.effectiveMachine(
      { type: 'managed_container', provider: 'aws_lightsail' },
      { cpuCores: 1, memoryGb: 2, diskGb: 10 },
    )).toEqual({ cpuCores: 1, memoryGb: 2, diskGb: 0 });
    expect(() => service.effectiveMachine(
      { type: 'managed_container', provider: 'aws_lightsail' },
      { cpuCores: 1, memoryGb: 3, diskGb: 10 },
    )).toThrow('AWS Lightsail does not support 1 vCPU and 3 GB memory');
  });

  test('dispatches artifact reconciliation only to the managed backend', async () => {
    const observed: unknown[] = [];
    const service = new AppHostingService({
      sandbox: {} as never,
      lightsail: {
        reconcileArtifacts: async (input: unknown) => {
          observed.push(input);
          return {
            contextsListed: 0,
            imagesListed: 0,
            servicesListed: 1,
            contextsDeleted: 0,
            imagesDeleted: 0,
            servicesDeleted: 1,
            errors: 0,
          };
        },
      } as never,
    });
    const input = {
      protectedDeploymentIds: new Set(['deployment-1']),
      protectedExternalIds: new Set(['service-1']),
    };

    await expect(service.reconcileManagedArtifacts(input as never))
      .resolves.toMatchObject({ servicesDeleted: 1, errors: 0 });
    expect(observed).toEqual([input]);
  });
});
