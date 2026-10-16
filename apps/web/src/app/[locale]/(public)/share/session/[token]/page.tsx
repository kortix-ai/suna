'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  ArrowsInSimpleIcon as ArrowsInSimple,
  ArrowsOutSimpleIcon as ArrowsOutSimple,
  CheckIcon,
  ArrowSquareOutIcon as ExternalLink,
  PlayIcon as Play,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { OutcomeTitle } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { framePolicy } from '@/features/file-viewer/preview-policy';
import { Copy } from '@/features/icon/icons/copy';
import { Download } from '@/features/icon/icons/download';
import { getAuthToken } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { getPublicSessionShare, getPublicShareByToken, startSessionWithToken } from '@kortix/sdk';
import { PublicFileShareView } from './public-file-share-view';
import { PublicTranscriptShareView } from './public-transcript-share-view';
import { downloadFileFromUrl, fileNameFromPath } from './share-file';
import { SHARE_PAGE_ROOT_CLASS, SHARE_PREVIEW_IFRAME_CLASS } from './share-layout';

interface PublicShareMeta {
  share: {
    share_id: string;
    session_id: string;
    project_id: string;
    resource_type: 'preview' | 'file' | 'transcript' | string;
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
  const router = useRouter();
  const token = params?.token as string;
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasAuth, setHasAuth] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const tCommon = useTranslations('common');
  // A transcript share is titled by the session's name. The share row's own
  // label is the generic "Conversation".
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  // Full screen here means "no share chrome" — the header unmounts and the
  // shared content owns the whole viewport. Deliberately not the native
  // Fullscreen API: the content is an iframe, and animating/entering native
  // fullscreen forces it to re-layout twice on a surface we do not control.
  const [fullscreen, setFullscreen] = useState(false);
  // "Copy link" confirms in place: the glyph and the label swap for a beat.
  const [copied, setCopied] = useState(false);

  const base = apiBase();
  const origin = apiOrigin();
  const iframeSrc = useMemo(() => {
    if (!meta?.share) return '';
    // Prefer `public_url`: when this deployment serves preview origins it is the
    // shared app's OWN origin, which is the only form where the app's
    // root-absolute links, fetch() calls and WebSockets work. The API falls back
    // to the path-proxy URL there when it has no preview domain, so this is
    // always at least as good as composing `proxy_path` ourselves — which stays
    // as the last resort for an older API that sends no `public_url`.
    if (meta.share.public_url) return meta.share.public_url;
    if (meta.share.proxy_path && origin) return `${origin}${meta.share.proxy_path}`;
    return '';
  }, [meta, origin]);
  const fileSrc = useMemo(() => {
    if (!meta?.share || meta.share.resource_type !== 'file') return '';
    // Prefer the shared file's own origin. A shared file is author-controlled
    // content, and HTML or SVG carries script — rendering it on the API origin
    // gives it the same principal as /v1/p/…. `public_url` is that origin when
    // the deployment serves one, and the path form otherwise.
    if (meta.share.public_url) return meta.share.public_url;
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
        if (body.share.resource_type === 'transcript') {
          // Title only, and not awaited: the transcript view mounts with `meta`
          // and starts its own /messages read in parallel. A failure keeps the
          // share label, never the error page.
          void getPublicSessionShare(token)
            .then((session) => {
              if (!cancelled) setSessionTitle(session.session.title || null);
            })
            .catch(() => {});
        }
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
    setStarting(true);
    setStartError(null);
    try {
      const authToken = await getAuthToken();
      if (!authToken) {
        // nav-contract: prefetch-only — a defensive bounce for a token that expired between render and click; the offline panel's Sign in <Link> already prefetches this href.
        router.push(`/auth?next=${encodeURIComponent(`/share/session/${token}`)}`);
        return;
      }
      await startSessionWithToken(meta.share.project_id, meta.share.session_id, {
        backendUrl: base,
        accessToken: authToken,
      });
      // Only `sandbox_status` changed. Re-read the share instead of reloading
      // the document — `meta` is the page's whole server-derived state.
      const body = await getPublicShareByToken<PublicShareMeta>(token, {
        backendUrl: base,
        cache: 'no-store',
      });
      setMeta(body);
    } catch (err) {
      setStartError((err instanceof Error && err.message) || tCommon.raw('error'));
    } finally {
      setStarting(false);
    }
  }

  const filePath = meta?.share.file_path || meta?.share.label || '';
  const fileName = fileNameFromPath(filePath, meta?.share.label ?? 'Shared file');
  const handleDownload = useCallback(() => {
    if (!fileSrc) return;
    void downloadFileFromUrl(fileSrc, fileName);
  }, [fileName, fileSrc]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // A blocked clipboard leaves the address bar as the way to copy.
    }
  }, []);

  if (loading) {
    return (
      <main className="bg-background text-foreground flex min-h-screen items-center justify-center">
        <Loading className="text-muted-foreground h-5 w-5" />
      </main>
    );
  }

  if (error || !meta) {
    // The quiet auth frame, like every other link a recipient can land on.
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={
              <OutcomeTitle tone="muted">
                {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextShareLink6d642641')}
              </OutcomeTitle>
            }
            description={error ?? tI18nHardcoded.raw('i18nComplete.text489314dd2a13')}
          />
        </Rise>
        <Rise delay={0.06}>
          <Button size="lg" variant="secondary" className="w-full" asChild>
            <Link href="/">{tI18nHardcoded.raw('i18nComplete.text5fae82827f98')}</Link>
          </Button>
        </Rise>
      </AuthFrame>
    );
  }

  const isFileShare = meta.share.resource_type === 'file';
  const isTranscriptShare = meta.share.resource_type === 'transcript';
  // A transcript needs no running sandbox: the API answers from the saved copy
  // when the session is stopped.
  const offline = !isTranscriptShare && meta.share.sandbox_status !== 'active';
  // A file share is titled by its file name only — the workspace path is
  // internal detail the recipient has no context for.
  const title = isFileShare
    ? fileName
    : isTranscriptShare
      ? (sessionTitle ?? meta.share.label)
      : meta.share.label;
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
        <header className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <KortixLogo variant="symbol" size={16} className="shrink-0" />
            <h1 className="truncate text-sm font-medium">{title}</h1>
          </div>
          {/* One group, one weight: every action is secondary, so the bar reads
              as a toolbar beside the shared content, never louder than it. */}
          <ButtonGroup className="shrink-0">
            {iframeSrc && !offline && !isFileShare && !isTranscriptShare && (
              <Hint label={openAppLabel} side="bottom">
                <Button
                  variant="secondary"
                  size="icon-base"
                  aria-label={openAppLabel}
                  onClick={() => window.open(iframeSrc, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink />
                </Button>
              </Hint>
            )}
            {/* Full screen exists for an iframe that needs the whole viewport.
                A transcript is a scrolling page; the header costs it nothing.
                An offline share has nothing to fill the screen with. */}
            {!isTranscriptShare && !offline && (
              <Hint label={tI18nHardcoded.raw('i18nComplete.text674fe2acd0d5')} side="bottom">
                <Button
                  variant="secondary"
                  size="icon-base"
                  aria-label={tI18nHardcoded.raw('i18nComplete.text674fe2acd0d5')}
                  onClick={() => setFullscreen(true)}
                >
                  <ArrowsOutSimple />
                </Button>
              </Hint>
            )}
            {isFileShare && !offline && fileSrc && (
              <Button variant="secondary" size="sm" onClick={handleDownload}>
                <Download />
                {tI18nHardcoded.raw('i18nComplete.textd6eafe823591')}
              </Button>
            )}
            {isTranscriptShare && (
              <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                {copied ? <CheckIcon /> : <Copy />}
                {copied
                  ? tI18nHardcoded.raw('i18nComplete.text8d525e5f158b')
                  : tI18nHardcoded.raw('i18nComplete.text9adff6870471')}
              </Button>
            )}
            {/* One CTA in both auth states. A signed-out visitor still wants
                "Open in Kortix"; sign-in is a step on the way there, not a
                different destination. Offline and signed out, the pane's
                Sign in is the only way on, so the bar shows no second copy. */}
            {offline && !hasAuth ? null : (
              <Button size="sm" variant="secondary" asChild>
                <Link href={hasAuth ? sessionHref : authHref} prefetch>
                  {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextOpenIn2fdbf464')}
                </Link>
              </Button>
            )}
          </ButtonGroup>
        </header>
      )}
      {/* Escape also exits, but focus inside the iframe never reaches the
          parent document — so the way out has to be visible. `secondary` is
          opaque: this floats over content whose colours we do not control. */}
      {fullscreen && (
        <Hint label={tI18nHardcoded.raw('i18nComplete.textdc5229faa653')} side="left">
          <Button
            variant="secondary"
            size="icon-base"
            aria-label={tI18nHardcoded.raw('i18nComplete.text897e0cf78b80')}
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
      <section className="bg-background border-border relative h-dvh min-h-0 flex-1 overflow-clip rounded-t-md border-x border-t">
        {isTranscriptShare ? (
          <PublicTranscriptShareView token={token} />
        ) : offline ? (
          hasAuth ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="flex max-w-sm flex-col items-center gap-6 text-center">
                <div className="space-y-2">
                  <h2 className="text-xl font-medium tracking-tight">{offlineTitle}</h2>
                  <p className="text-muted-foreground text-sm text-pretty">{offlineDescription}</p>
                </div>
                {startError && (
                  <InfoBanner className="w-full" tone="destructive" role="alert">
                    {startError}
                  </InfoBanner>
                )}
                <Button
                  onClick={startSession}
                  disabled={starting}
                  aria-busy={starting || undefined}
                >
                  {starting ? <Loading /> : <Play weight="fill" />}
                  {startError
                    ? tCommon.raw('retry')
                    : tI18nHardcoded.raw(
                        'autoAppPublicShareSessionTokenPageJsxTextStartSessiond4216ec8',
                      )}
                </Button>
              </div>
            </div>
          ) : (
            // Signed out: the /auth column, so sign-in reads as the next step.
            <div className="flex h-full items-center justify-center px-6">
              <div className="w-full max-w-[380px]">
                <div className="mb-10 space-y-2">
                  <h2 className="text-2xl font-medium tracking-tight text-balance">
                    {offlineTitle}
                  </h2>
                  <p className="text-muted-foreground text-sm text-pretty">{offlineDescription}</p>
                </div>
                <Button size="lg" className="w-full" asChild>
                  <Link href={authHref} prefetch>
                    {tI18nHardcoded.raw('autoAppPublicShareSessionTokenPageJsxTextSignInb66c3487')}
                  </Link>
                </Button>
              </div>
            </div>
          )
        ) : isFileShare ? (
          <PublicFileShareView token={token} share={meta.share} fileUrl={fileSrc} />
        ) : (
          <iframe
            title={title}
            src={iframeSrc}
            className={SHARE_PREVIEW_IFRAME_CLASS}
            // A sandbox attribute is a token list the browser parses, not copy.
            // Sent through i18n it was translated — Spanish shipped
            // "permitir-mismo-origen", German comma-separated — and an
            // unrecognized token list means MAXIMALLY restrictive: no scripts,
            // no same-origin. Every shared preview was a dead blank frame in
            // seven of eight locales.
            sandbox={framePolicy('app', iframeSrc).sandbox}
          />
        )}
      </section>
    </main>
  );
}
