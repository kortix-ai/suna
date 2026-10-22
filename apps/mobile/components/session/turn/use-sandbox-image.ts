import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSandboxImage as useSdkSandboxImage } from '@kortix/sdk/react';

// The sandbox binding of the SDK's sandbox-image loader (`useSandboxImage` in
// `@kortix/sdk/react`): the sandbox origin comes from SandboxContext; the HEAD
// probe, auth headers, size gate, probe cache and the one fresh-token retry
// live in the SDK.
export function useSandboxImage(filePath: string, enabled: boolean) {
  const { sandboxUrl } = useSandboxContext();
  return useSdkSandboxImage({ sandboxUrl, filePath, enabled });
}
