'use client';

/**
 * Thin wrapper over `@kortix/sdk/react` (`use-kortix-master.ts`): the
 * react-query layer (query keys, caching, invalidation) lives in the SDK
 * now. This file's only job is injecting web's actor identity — derived from
 * `useAuth()` — into the SDK's `KortixMasterIdentity` seam, and re-exporting
 * under the same names so every existing importer of
 * `apps/web/src/hooks/use-sandbox-services` keeps working unchanged.
 */

import { useAuth } from '@/features/providers/auth-provider';
import {
  serviceKeys,
  useSandboxServices as useSandboxServicesSdk,
  useSandboxServiceTemplates as useSandboxServiceTemplatesSdk,
  useSandboxServiceLogs as useSandboxServiceLogsSdk,
  useSandboxServiceAction,
  useSandboxServiceReconcile,
  useRegisterSandboxService,
  useSandboxRuntimeReload,
  type KortixMasterIdentity,
  type SandboxServiceStatus,
  type SandboxServiceAdapter,
  type SandboxServiceScope,
  type SandboxService,
  type SandboxServiceTemplate,
  type RegisterSandboxServicePayload,
  type ServiceAction,
} from '@kortix/sdk/react';

// The request/response shapes live in the SDK now (`@kortix/sdk/react`);
// re-exported here for existing importers.
export type {
  SandboxServiceStatus,
  SandboxServiceAdapter,
  SandboxServiceScope,
  SandboxService,
  SandboxServiceTemplate,
  RegisterSandboxServicePayload,
  ServiceAction,
};

export { serviceKeys, useSandboxServiceAction, useSandboxServiceReconcile, useRegisterSandboxService, useSandboxRuntimeReload };

function useServicesIdentity(): KortixMasterIdentity {
  const { user, isLoading } = useAuth();
  return { userId: user?.id ?? null, handle: 'me', isLoading };
}

export function useSandboxServices(options?: { enabled?: boolean; includeAll?: boolean }) {
  const identity = useServicesIdentity();
  return useSandboxServicesSdk(identity, options);
}

export function useSandboxServiceTemplates(options?: { enabled?: boolean }) {
  const identity = useServicesIdentity();
  return useSandboxServiceTemplatesSdk(identity, options);
}

export function useSandboxServiceLogs(serviceId: string | null, options?: { enabled?: boolean }) {
  const identity = useServicesIdentity();
  return useSandboxServiceLogsSdk(identity, serviceId, options);
}
