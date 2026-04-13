'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCw, Maximize2, Minimize2, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchAdminSandboxProxyToken } from '@/hooks/admin/use-admin-sandboxes';

interface SandboxWebTerminalProps {
  sandboxId: string;
  externalId: string | null;
  status: string | null;
  ip?: string | null;
  /** Full terminal URL from JustAVPS (e.g. https://slug.kortix.cloud/_terminal). If omitted, fetched via proxy-token endpoint. */
  terminalUrl?: string | null;
  label?: string;
}

async function buildAuthedUrl(sandboxId: string, fallbackUrl: string | null): Promise<string | null> {
  try {
    const res = await fetchAdminSandboxProxyToken(sandboxId);
    const baseUrl = res.terminal_url ?? fallbackUrl;
    if (!baseUrl) return null;
    const url = new URL(baseUrl);
    url.searchParams.set('__proxy_token', res.token);
    return url.toString();
  } catch {
    return null;
  }
}

export default function SandboxWebTerminal({
  sandboxId,
  externalId,
  status,
  ip,
  terminalUrl,
  label,
}: SandboxWebTerminalProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isReady = status === 'ready' || status === 'active' || !!ip;
  const shouldConnect = !!(externalId && isReady);

  useEffect(() => {
    if (!shouldConnect) return;
    let cancelled = false;
    setError(null);
    buildAuthedUrl(sandboxId, terminalUrl ?? null).then((url) => {
      if (cancelled) return;
      if (url) setAuthUrl(url);
      else setError('Failed to issue proxy token. The JustAVPS API key may lack permissions, or the machine has no terminal URL yet.');
    });
    return () => { cancelled = true; };
  }, [shouldConnect, sandboxId, terminalUrl]);

  const handleReload = useCallback(() => {
    setIframeLoaded(false);
    setError(null);
    buildAuthedUrl(sandboxId, terminalUrl ?? null).then((url) => {
      if (url) {
        setAuthUrl(url);
        setIframeKey((k) => k + 1);
      } else {
        setError('Failed to refresh terminal session.');
      }
    });
  }, [sandboxId, terminalUrl]);

  const handleOpenNewTab = useCallback(async () => {
    const url = await buildAuthedUrl(sandboxId, terminalUrl ?? null);
    if (url) window.open(url, '_blank');
  }, [sandboxId, terminalUrl]);

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'focus' }, '*');
    }, 100);
  }, []);

  const loading = useMemo(() => !authUrl || !iframeLoaded, [authUrl, iframeLoaded]);

  if (!isReady || !externalId) {
    return (
      <div className="rounded-xl border bg-[#09090b] overflow-hidden">
        <div className="flex items-center justify-center h-[400px]">
          <div className="text-center space-y-2">
            <Loader2 className="size-5 animate-spin text-yellow-500 mx-auto" />
            <p className="text-sm text-zinc-500">Waiting for sandbox to be ready…</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !authUrl) {
    return (
      <div className="rounded-xl border bg-[#09090b] overflow-hidden">
        <div className="flex flex-col items-center justify-center h-[400px] gap-3 px-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={handleReload}>
            <RotateCw className="size-3.5 mr-1.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-xl overflow-hidden border bg-[#09090b] flex flex-col transition-all duration-200',
        isFullscreen && 'fixed inset-3 z-50 shadow-2xl border-primary/20',
      )}
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="size-2.5 rounded-full bg-red-500/80" />
            <div className="size-2.5 rounded-full bg-yellow-500/80" />
            <div className="size-2.5 rounded-full bg-green-500/80" />
          </div>
          <span className="text-[11px] text-zinc-500 font-mono ml-1.5">
            {label ?? sandboxId.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800" onClick={handleReload} title="Reconnect">
            <RotateCw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800" onClick={handleOpenNewTab} title="Open in new tab">
            <ExternalLink className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800" onClick={() => setIsFullscreen((f) => !f)} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden" style={{ height: isFullscreen ? 'calc(100vh - 68px)' : '600px' }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#09090b] z-10">
            <div className="text-center space-y-2">
              <Loader2 className="size-5 animate-spin text-zinc-500 mx-auto" />
              <p className="text-xs text-zinc-600">Connecting…</p>
            </div>
          </div>
        )}
        {authUrl && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={authUrl}
            onLoad={handleIframeLoad}
            className="block border-0"
            style={{ width: '100%', height: '100%' }}
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}
