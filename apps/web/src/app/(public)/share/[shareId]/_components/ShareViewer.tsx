'use client';

import { useTranslations } from 'next-intl';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { errorToast, successToast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  WarningIcon as AlertTriangle,
  CheckIcon as Check,
  CopyIcon as Copy,
  ThumbsDownIcon as ThumbsDown,
  ThumbsUpIcon as ThumbsUp,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ============================================================================
// Data fetching — GENUINELY anonymous, server-to-sandbox. `shareId` is the
// public share's raw `share_id` (the same uuid the authenticated CRUD calls
// `share.share_id` — see `apps/api/src/shared/session-public-shares.ts`), NOT
// the `kps_...` public token every other public-share surface uses. The new
// `GET /v1/public/session-shares/:shareId[/messages]` routes
// (`apps/api/src/public-session-shares/index.ts`) derive the token
// server-side and resolve through the same `resolvePublicShare()` gate the
// authenticated CRUD and `/v1/p/public-share/:token` both use, so this page
// inherits identical 404 (unknown) / 410 (revoked or expired) / 503
// (sandbox not provisioned yet) semantics.
//
// Before this, this page had no way to reach a session's conversation at
// all for a logged-out visitor: it read whatever `getActiveOpenCodeUrl()`
// resolved to on the CLIENT (a self-hosted, single-runtime concept with no
// access control), and the platform's own public-share proxy deliberately
// blocks the OpenCode API port (`PUBLIC_SHARE_BLOCKED_PORTS` in
// `shared/session-public-shares.ts`) — this route never carried a share
// token in the first place. The API now does the sandbox round-trip
// server-side and returns a sanitized, text-only transcript digest — no
// client-side sandbox access here at all.
// ============================================================================

import {
  getPublicSessionShare,
  getPublicSessionShareMessages,
  type PublicSessionShareMeta,
  type PublicSessionTranscript,
  type PublicSessionTranscriptMessage,
} from '@kortix/sdk';
import {
  describeShareError,
  toShareLoadError,
  transcriptUnavailableMessage,
  type ShareLoadError,
} from './share-load-error';

interface ShareData {
  meta: PublicSessionShareMeta;
  transcript: PublicSessionTranscript;
}

async function fetchShareData(shareId: string): Promise<ShareData> {
  const [meta, transcript] = await Promise.all([
    getPublicSessionShare(shareId),
    getPublicSessionShareMessages(shareId),
  ]);
  return { meta, transcript };
}

// ============================================================================
// Share Viewer Component
// ============================================================================

export function ShareViewer({ shareId }: { shareId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<ShareLoadError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchShareData(shareId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(toShareLoadError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const messages = useMemo(() => {
    if (!data) return [];
    return [...data.transcript.messages]
      .filter((m) => m.text.trim().length > 0)
      .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
  }, [data]);

  // ---------- Loading state ----------
  if (loading) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <KortixLoader size="medium" />
          <p className="text-muted-foreground text-sm">
            {tHardcodedUi.raw(
              'appShareShareidComponentsShareviewer.line147JsxTextLoadingSharedSession',
            )}
          </p>
        </div>
      </div>
    );
  }

  // ---------- Error state ----------
  if (error || !data) {
    const { title, description } = describeShareError(error);
    return (
      <div className="bg-background flex h-screen items-center justify-center p-4">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="bg-muted rounded-full p-3">
            <AlertTriangle className="text-muted-foreground h-5 w-5" />
          </div>
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
      </div>
    );
  }

  const { meta, transcript } = data;
  const sessionTitle = meta.session.title || 'Shared session';

  return (
    <div className="bg-background flex h-screen flex-col">
      {/* ── Header (matches Suna thread-site-header variant="shared") ── */}
      <ShareHeader sessionTitle={sessionTitle} />

      {/* ── Message list ── */}
      <div className="scrollbar-hide bg-background min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-0">
        <div className="mx-auto w-full max-w-3xl min-w-0 px-3 sm:px-6">
          <div className="min-w-0 space-y-6">
            {!transcript.available && (
              <p className="text-muted-foreground py-8 text-center text-sm">
                {transcriptUnavailableMessage(transcript.reason)}
              </p>
            )}
            {messages.map((msg, index) => (
              <ShareMessageView key={`${msg.role}-${msg.created ?? index}`} message={msg} />
            ))}
          </div>
          {/* Bottom spacer */}
          <div className="!h-8" />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Header — matches Suna SiteHeader variant="shared"
// ============================================================================

function ShareHeader({ sessionTitle }: { sessionTitle: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      successToast('Share link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast('Failed to copy link');
    }
  };

  return (
    <header className="bg-background sticky top-0 z-20 h-12 w-full shrink-0 sm:h-14">
      <div className="flex h-full items-center justify-between px-3 sm:px-4">
        {/* Left side — title + "Shared" badge */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="max-w-[140px] truncate sm:max-w-none">{sessionTitle}</span>
            <Badge size="sm" variant="secondary" className="shrink-0">
              Shared
            </Badge>
          </div>
        </div>

        {/* Right side — Copy Link */}
        <div className="flex shrink-0 items-center gap-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={copyShareLink}
                  size="sm"
                  className="cursor-pointer gap-1.5 px-2.5"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span className="hidden text-sm sm:inline">
                    {copied ? 'Copied!' : 'Copy Link'}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>
                  {tHardcodedUi.raw(
                    'appShareShareidComponentsShareviewer.line252JsxTextCopyShareLink',
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </header>
  );
}

// ============================================================================
// Message views — matches Suna UserMessageRow + AssistantGroupRow
// ============================================================================

function ShareMessageView({ message }: { message: PublicSessionTranscriptMessage }) {
  if (message.role === 'user') {
    return <UserBubble text={message.text} />;
  }
  return <AssistantBlock text={message.text} />;
}

// ── User message bubble (matches Suna UserMessageRow) ──

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-card flex max-w-[90%] overflow-hidden rounded-3xl rounded-br-lg border px-4 py-3 wrap-break-word">
        <div className="min-w-0 flex-1 space-y-2">
          <UnifiedMarkdown content={text} />
        </div>
      </div>
    </div>
  );
}

// ── Assistant message block (matches Suna AssistantGroupRow) ──

function AssistantBlock({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {/* Agent header — Kortix logomark (matches Suna AgentHeader for name="Kortix") */}
      <div className="flex items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/kortix-logomark-white.svg"
          alt="Kortix"
          className="shrink-0 invert dark:invert-0"
          style={{ height: '12px', width: 'auto' }}
        />
      </div>

      {/* Text content */}
      <div className="flex w-full wrap-break-word">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="overflow-hidden wrap-break-word">
            <UnifiedMarkdown content={text} />
          </div>

          {/* Message actions — Copy + Thumbs (matches Suna MessageActions) */}
          <MessageActions text={text} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MessageActions — matches Suna MessageActions component
// ============================================================================

function MessageActions({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [text]);

  const handleLike = useCallback(() => {
    setLiked((v) => !v);
    setDisliked(false);
  }, []);

  const handleDislike = useCallback(() => {
    setDisliked((v) => !v);
    setLiked(false);
  }, []);

  if (!text?.trim()) return null;

  return (
    <div className={cn('mt-2 flex items-center gap-1', className || '')}>
      {/* Copy */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-7 w-7 transition-colors"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="text-foreground h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{copied ? 'Copied!' : 'Copy'}</p>
        </TooltipContent>
      </Tooltip>

      {/* Thumbs up */}
      <AnimatePresence mode="popLayout">
        {!disliked && (
          <m.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-7 w-7 transition-colors"
              onClick={handleLike}
            >
              <ThumbsUp className="h-3.5 w-3.5" fill={liked ? 'currentColor' : 'none'} />
            </Button>
          </m.div>
        )}
      </AnimatePresence>

      {/* Thumbs down */}
      <AnimatePresence mode="popLayout">
        {!liked && (
          <m.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-7 w-7 transition-colors"
              onClick={handleDislike}
            >
              <ThumbsDown className="h-3.5 w-3.5" fill={disliked ? 'currentColor' : 'none'} />
            </Button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
