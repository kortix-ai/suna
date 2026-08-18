'use client';

import {
  ArrowsInSimpleIcon as ArrowsInSimple,
  ArrowsOutSimpleIcon as ArrowsOutSimple,
  DownloadIcon as Download,
  ArrowSquareOutIcon as ExternalLink,
  PlayIcon as Play,
  ShieldWarningIcon as ShieldAlert,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { getAuthToken } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { getPublicShareByToken, startSessionWithToken } from '@kortix/sdk';
import { PublicFileShareView } from './public-file-share-view';
import { downloadFileFromUrl, fileNameFromPath } from './share-file';
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
  // Full screen here means "no share chrome" — the header unmounts and the
  // shared content owns the whole viewport. Deliberately not the native
  // Fullscreen API: the content is an iframe, and animating/entering native
  // fullscreen forces it to re-layout twice on a surface we do not control.
  const [fullscreen, setFullscreen] = useState(false);

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
      setLoading(true);
      setError(null);
      try {
        if (!token) {
          setError('Invalid share link');
          return;
        }
        const body = await getPublicShareByToken<PublicShareMeta>(token, {
          backendUrl: base,
          cache: 'no-store',
        });
        if (!cancelled) setMeta(body);
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

  // Escape leaves full screen. Focus inside the iframe never reaches this
  // listener, which is why the floating exit control below stays visible.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  async function startSession() {
    if (!meta) return;
    const authToken = await getAuthToken();
    if (!authToken) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setStarting(true);
    try {
      await startSessionWithToken(meta.share.project_id, meta.share.session_id, {
        backendUrl: base,
        accessToken: authToken,
      });
      window.location.reload();
    } finally {
      setStarting(false);
    }
  }

  function signInForAccess() {
    window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
  }

  const filePath = meta?.share.file_path || meta?.share.label || '';
  const fileName = fileNameFromPath(filePath, meta?.share.label ?? 'Shared file');
  const handleDownload = useCallback(() => {
    if (!fileSrc) return;
    void downloadFileFromUrl(fileSrc, fileName);
  }, [fileName, fileSrc]);

  if (loading) {
    return (
      <main className="bg-background text-foreground flex min-h-screen items-center justify-center">
        <Loading className="text-muted-foreground h-5 w-5" />
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
  // A file share is titled by its file name only — the workspace path is
  // internal detail the recipient has no context for.
  const title = isFileShare ? fileName : meta.share.label;
  const authHref = `/auth?next=${encodeURIComponent(`/share/session/${token}`)}`;
  const sessionHref = `/projects/${meta.share.project_id}/sessions/${meta.share.session_id}`;
  const offlineTitle = isFileShare
    ? 'This shared file is offline'
    : 'This shared preview is offline';
  const offlineDescription = isFileShare
    ? 'The session runtime that serves this file is not active. Sign in with access to this project to start it.'
    : 'The session runtime is not active. Sign in with access to this project to start it.';

  const openAppLabel = tI18nHardcoded.raw(
    'autoAppPublicShareSessionTokenPageJsxTextOpenAppa9aa1bb9',
  );

  return (
    <main className={SHARE_PAGE_ROOT_CLASS}>
      {/* Bar shape copied from the file viewer toolbar (file-preview-modal.tsx):
          h-12, gap-2, px-3, name left, actions right. No border-b — the pane
          below draws the seam with its own top border. */}
      {!fullscreen && (
        <header className="flex py-2 shrink-0 items-center gap-2 px-3.5 pr-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <KortixLogo variant="symbol" size={16} className="shrink-0" />
            <h1 className="truncate text-sm font-medium">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {offline && hasAuth && (
              <Button size="sm" onClick={startSession} disabled={starting}>
                {starting ? <Loading /> : <Play />}
                Start
              </Button>
            )}
            {isFileShare && !offline && fileSrc && (
              <Hint label="Download" side="bottom">
                <Button
                  variant="ghost"
                  size="icon-base"
                  aria-label="Download"
                  onClick={handleDownload}
                >
                  <Download />
                </Button>
              </Hint>
            )}
            {iframeSrc && !offline && !isFileShare && (
              <Hint label={openAppLabel} side="bottom">
                <Button
                  variant="ghost"
                  size="icon-base"
                  aria-label={openAppLabel}
                  onClick={() => window.open(iframeSrc, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink />
                </Button>
              </Hint>
            )}
            {/* One CTA in both auth states. A signed-out visitor still wants
                "Open in Kortix"; sign-in is a step on the way there, not a
                different destination. */}
            <Button
              size="sm"
              onClick={() => {
                window.location.href = hasAuth ? sessionHref : authHref;
              }}
            >
              {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextOpenIn2fdbf464')}
            </Button>
            <Hint label="Full screen" side="bottom">
              <Button
                variant="ghost"
                size="icon-base"
                aria-label="Full screen"
                onClick={() => setFullscreen(true)}
              >
                <ArrowsOutSimple />
              </Button>
            </Hint>
          </div>
        </header>
      )}
      {/* Escape also exits, but focus inside the iframe never reaches the
          parent document — so the way out has to be visible. `secondary` is
          opaque: this floats over content whose colours we do not control. */}
      {fullscreen && (
        <Hint label="Exit full screen (Esc)" side="left">
          <Button
            variant="secondary"
            size="icon-base"
            aria-label="Exit full screen"
            className="fixed top-2 right-3 z-50 shadow-md"
            onClick={() => setFullscreen(false)}
          >
            <ArrowsInSimple />
          </Button>
        </Hint>
      )}
      {/* `overflow-clip` is what makes `rounded-t-md` visible: without it the
          iframe paints its square background over the corners. `clip` rather
          than `hidden` so this never becomes a scrollable box — the scrolling
          belongs to the child. */}
      <section className="bg-background border-border relative min-h-0 h-dvh flex-1 overflow-clip rounded-t-md border-x border-t">
        {offline ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <h2 className="text-base font-semibold">{offlineTitle}</h2>
              <p className="text-muted-foreground mt-2 text-sm">{offlineDescription}</p>
              {hasAuth ? (
                <Button className="mt-5" onClick={startSession} disabled={starting}>
                  {starting ? <Loading /> : <Play />}
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
            title={title}
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
