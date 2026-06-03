'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

const tunnelKeys = {
  deviceAuth: (code: string) => ['tunnel', 'device-auth', code] as const,
};

interface DeviceAuthInfo {
  deviceCode: string;
  machineHostname: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export function useDeviceAuthInfo(code: string) {
  return useQuery({
    queryKey: tunnelKeys.deviceAuth(code),
    queryFn: async () => {
      const res = await backendApi.get<DeviceAuthInfo>(`/tunnel/device-auth/${code}/info`, {
        showErrors: false,
        timeout: 10_000,
      });
      if (!res.success) throw new Error(res.error?.message || 'Failed to fetch device auth info');
      return res.data!;
    },
    enabled: !!code,
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useApproveDeviceAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, ...data }: {
      code: string;
      name?: string;
      capabilities?: string[];
    }) => {
      const res = await backendApi.post<{ success: boolean; tunnelId: string }>(
        `/tunnel/device-auth/${code}/approve`,
        data,
      );
      if (!res.success) throw new Error(res.error?.message || 'Failed to approve device');
      return res.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.deviceAuth(vars.code) });
    },
  });
}

export function useDenyDeviceAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const res = await backendApi.post(`/tunnel/device-auth/${code}/deny`);
      if (!res.success) throw new Error(res.error?.message || 'Failed to deny device');
    },
    onSuccess: (_, code) => {
      queryClient.invalidateQueries({ queryKey: tunnelKeys.deviceAuth(code) });
    },
  });
}
