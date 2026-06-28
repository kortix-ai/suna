'use client';

import { ExternalLink, FileText, Globe, Loader2, LogIn, Play, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { getAuthToken } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { cn } from '@/lib/utils';
import { PublicFileShareView } from './public-file-share-view';
import { SHARE_PAGE_ROOT_CLASS, SHARE_PREVIEW_IFRAME_CLASS } from './share-layout';

interface PublicShareMeta {
  share: {
    share_id: string;
    session_id: string;
    project_id: string;
    resource_type: 'preview' | 'file' | string;
    label: string;
    port: number | null;
    path: string;
    file_path: string | null;
    mode: string;
    sandbox_status: string;
    expires_at: string | null;
    proxy_path: string;
    public_url: string | null;
  };
}

function apiBase() {
  return (getEnv().BACKEND_URL || '').replace(/\/$/, '');
}

function apiOrigin() {
  try {
    return new URL(apiBase()).origin;
  } catch {
    return '';
  }
}

export default function PublicSessionSharePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const params = useParams();
  const token = params?.token as string;
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasAuth, setHasAuth] = useState(false);
  const [starting, setStarting] = useState(false);

  const base = apiBase();
  const origin = apiOrigin();
  const iframeSrc = useMemo(() => {
    if (!meta?.share) return '';
    // Prefer the path-based proxy on the same origin we just fetched metadata
    // from — it always resolves. `public_url` is a fallback for older responses.
    if (meta.share.proxy_path && origin) return `${origin}${meta.share.proxy_path}`;
    return meta.share.public_url || '';
  }, [meta, origin]);
  const fileSrc = useMemo(() => {
    if (!meta?.share || meta.share.resource_type !== 'file') return '';
    if (!meta.share.proxy_path || !origin) return '';
    return `${origin}${meta.share.proxy_path}`;
  }, [meta, origin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setError('Invalid share link');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${base}/p/public-share/${encodeURIComponent(token)}`, {
          cache: 'no-store',
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || 'Share link unavailable');
        if (!cancelled) setMeta(body as PublicShareMeta);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Share link unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    getAuthToken().then((authToken) => {
      if (!cancelled) setHasAuth(Boolean(authToken));
    });
    return () => {
      cancelled = true;
    };
  }, [base, token]);

  async function startSession() {
    if (!meta) return;
    const authToken = await getAuthToken();
    if (!authToken) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setStarting(true);
    try {
      await fetch(
        `${base}/projects/${meta.share.project_id}/sessions/${meta.share.session_id}/start`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
      );
      window.location.reload();
    } finally {
      setStarting(false);
    }
  }

  function signInForAccess() {
    window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
  }

  if (loading) {
    return (
      <main className="bg-background text-foreground flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </main>
    );
  }

  if (error || !meta) {
    return (
      <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <ShieldAlert className="text-muted-foreground mx-auto mb-4 h-8 w-8" />
          <h1 className="text-lg font-semibold">
            {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextShareLink6d642641')}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {error ?? 'This link cannot be opened.'}
          </p>
        </div>
      </main>
    );
  }

  const offline = meta.share.sandbox_status !== 'active';
  const isFileShare = meta.share.resource_type === 'file';
  const Icon = isFileShare ? FileText : Globe;
  const shareType = isFileShare ? 'File share' : 'Preview share';
  const sharePermission = isFileShare
    ? 'View only · no workspace browsing'
    : 'No terminal, files, or session controls';
  const sessionHref = `/projects/${meta.share.project_id}/sessions/${meta.share.session_id}`;
  const offlineTitle = isFileShare
    ? 'This shared file is offline'
    : 'This shared preview is offline';
  const offlineDescription = isFileShare
    ? 'The session runtime that serves this file is not active. Sign in with access to this project to start it.'
    : 'The session runtime is not active. Sign in with access to this project to start it.';

  return (
    <main className={SHARE_PAGE_ROOT_CLASS}>
      <header className="border-border/70 bg-background/95 flex min-h-[64px] flex-col gap-3 border-b px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex shrink-0 items-center gap-2.5">
            <KortixLogo variant="logomark" size={18} className="text-foreground" />
            <span className="bg-border hidden h-4 w-px sm:block" />
            <span className="text-muted-foreground text-xs font-medium">
              {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextPublicSharedbc2d952')}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className={cn(
                'border-border/70 bg-muted/40 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border',
                isFileShare ? 'text-muted-foreground' : 'text-primary',
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h1 className="max-w-full truncate text-sm font-medium">{meta.share.label}</h1>
                <span className="text-muted-foreground text-xs">{shareType}</span>
              </div>
              <p className="text-muted-foreground mt-0.5 truncate text-xs">{sharePermission}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {offline && hasAuth && (
            <Button size="sm" className="h-8 gap-1.5" onClick={startSession} disabled={starting}>
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Start
            </Button>
          )}
          {!hasAuth ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={signInForAccess}>
              <LogIn className="h-3.5 w-3.5" />
              {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextSignInc63c237b')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={offline ? 'outline' : 'ghost'}
              className="h-8 gap-1.5"
              onClick={() => {
                window.location.href = sessionHref;
              }}
            >
              {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextOpenIn2fdbf464')}
            </Button>
          )}
          {iframeSrc && !offline && !isFileShare && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => window.open(iframeSrc, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextOpenAppa9aa1bb9')}
            </Button>
          )}
        </div>
      </header>
      <section className="relative min-h-0 flex-1">
        {offline ? (
          <div className="flex h-full min-h-[60vh] items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <h2 className="text-base font-semibold">{offlineTitle}</h2>
              <p className="text-muted-foreground mt-2 text-sm">{offlineDescription}</p>
              {hasAuth ? (
                <Button className="mt-5 gap-1.5" onClick={startSession} disabled={starting}>
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {tI18nHardcoded.raw(
                    'autoAppPublicShareSessionTokenPageJsxTextStartSessiond4216ec8',
                  )}
                </Button>
              ) : (
                <Button className="mt-5" onClick={signInForAccess}>
                  {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextSignInb66c3487')}
                </Button>
              )}
            </div>
          </div>
        ) : isFileShare ? (
          <PublicFileShareView token={token} share={meta.share} fileUrl={fileSrc} />
        ) : (
          <iframe
            title={meta.share.label}
            src={iframeSrc}
            className={SHARE_PREVIEW_IFRAME_CLASS}
            sandbox={tI18nHardcoded.raw(
              'autoAppPublicShareSessionTokenPageJsxAttrSandboxAllow2840c013',
            )}
          />
        )}
      </section>
    </main>
  );
}
