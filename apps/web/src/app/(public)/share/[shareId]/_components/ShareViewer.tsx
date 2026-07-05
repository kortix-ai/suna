'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { KortixLoader } from '@/components/ui/kortix-loader';
import {
  AlertTriangle,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { motion, AnimatePresence } from 'motion/react';

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
} from '@kortix/sdk/projects-client';
import { describeShareError, toShareLoadError, transcriptUnavailableMessage, type ShareLoadError } from './share-load-error';

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
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(toShareLoadError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
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
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <KortixLoader size="medium" />
          <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appShareShareidComponentsShareviewer.line147JsxTextLoadingSharedSession')}</p>
        </div>
      </div>
    );
  }

  // ---------- Error state ----------
  if (error || !data) {
    const { title, description } = describeShareError(error);
    return (
      <div className="flex h-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="rounded-full bg-muted p-3">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    );
  }

  const { meta, transcript } = data;
  const sessionTitle = meta.session.title || 'Shared session';

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Header (matches Suna thread-site-header variant="shared") ── */}
      <ShareHeader sessionTitle={sessionTitle} />

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0 bg-background min-h-0">
        <div className="mx-auto max-w-3xl min-w-0 w-full px-3 sm:px-6">
          <div className="space-y-6 min-w-0">
            {!transcript.available && (
              <p className="text-sm text-muted-foreground text-center py-8">
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
      toast.success('Share link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  };

  return (
    <header className="bg-background sticky top-0 z-20 w-full h-12 sm:h-14 flex-shrink-0">
      <div className="h-full flex items-center justify-between px-3 sm:px-4">
        {/* Left side — title + "Shared" badge */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <div className="text-sm font-medium text-muted-foreground flex items-center gap-2 min-w-0">
            <span className="truncate max-w-[140px] sm:max-w-none">{sessionTitle}</span>
            <Badge size="sm" variant="secondary" className="shrink-0">
              Shared
            </Badge>
          </div>
        </div>

        {/* Right side — Copy Link */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={copyShareLink}
                  size="sm"
                  className="px-2.5 cursor-pointer gap-1.5"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  <span className="hidden sm:inline text-sm">{copied ? 'Copied!' : 'Copy Link'}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{tHardcodedUi.raw('appShareShareidComponentsShareviewer.line252JsxTextCopyShareLink')}</p>
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
      <div className="flex max-w-[90%] rounded-3xl rounded-br-lg bg-card border px-4 py-3 break-words overflow-hidden">
        <div className="space-y-2 min-w-0 flex-1">
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
          className="dark:invert-0 invert flex-shrink-0"
          style={{ height: '12px', width: 'auto' }}
        />
      </div>

      {/* Text content */}
      <div className="flex w-full break-words">
        <div className="space-y-1.5 min-w-0 flex-1">
          <div className="break-words overflow-hidden">
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
    <div className={cn('flex items-center gap-1 mt-2', className || '')}>
      {/* Copy */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-foreground" />
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
          <motion.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleLike}
            >
              <ThumbsUp
                className="h-3.5 w-3.5"
                fill={liked ? 'currentColor' : 'none'}
              />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Thumbs down */}
      <AnimatePresence mode="popLayout">
        {!liked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleDislike}
            >
              <ThumbsDown
                className="h-3.5 w-3.5"
                fill={disliked ? 'currentColor' : 'none'}
              />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
