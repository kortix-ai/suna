import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLatestSandboxVersion } from '@/lib/platform/client';
import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';

function useSandboxVersionInfo(currentVersion: string | null | undefined) {
  const { data: versionInfo, isLoading, refetch } = useQuery({
    queryKey: ['sandbox', 'latest-version'],
    queryFn: getLatestSandboxVersion,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    enabled: !!currentVersion,
  });

  const latestVersion = versionInfo?.version ?? null;

  return {
    currentVersion: currentVersion ?? null,
    latestVersion,
    changelog: versionInfo?.changelog ?? null,
    isLoading,
    refetch,
  };
}

export function useGlobalSandboxUpdate() {
  const { sandboxUrl } = useSandboxContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [fetchSeq, setFetchSeq] = useState(0);

  useEffect(() => {
    if (!sandboxUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${sandboxUrl}/kortix/health`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.version && data.version !== 'unknown') {
          setCurrentVersion(data.version);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [sandboxUrl, fetchSeq]);

  const refreshCurrentVersion = useCallback(() => {
    setFetchSeq((s) => s + 1);
  }, []);

  const versionInfo = useSandboxVersionInfo(currentVersion);
  return { ...versionInfo, refreshCurrentVersion };
}
