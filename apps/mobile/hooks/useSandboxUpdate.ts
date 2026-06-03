import { useCallback, useEffect, useState } from 'react';
import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';

export function useGlobalSandboxUpdate() {
  const { sandboxUrl } = useSandboxContext();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchSeq, setFetchSeq] = useState(0);

  useEffect(() => {
    if (!sandboxUrl) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
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
      } catch {
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sandboxUrl, fetchSeq]);

  const refreshCurrentVersion = useCallback(() => {
    setFetchSeq((s) => s + 1);
  }, []);

  return {
    currentVersion,
    latestVersion: null,
    changelog: null,
    isLoading,
    refetch: refreshCurrentVersion,
    refreshCurrentVersion,
  };
}
