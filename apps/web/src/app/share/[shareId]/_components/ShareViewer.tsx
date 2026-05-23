'use client';

import { cn } from '@/lib/utils';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { getEnv } from '@/lib/env-config';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { KortixLoader } from '@/components/ui/kortix-loader';
import {
  AlertTriangle,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  PanelRightOpen,
  PanelRightClose,
  Menu,
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
import { motion, AnimatePresence } from 'framer-motion';

// ============================================================================
// Types
// ============================================================================

interface SessionInfo {
  id: string;
  title: string;
  version?: string;
  time: { created: number; updated?: number };
  share?: { url: string };
}

interface MessagePart {
  id: string;
  type: string;
  text?: string;
  content?: any;
  time?: { created: number; updated?: number };
}

interface MessageWithParts {
  info: {
    id: string;
    sessionID: string;
    role: 'user' | 'assistant';
    time: { created: number; updated?: number };
  };
  parts: MessagePart[];
}

interface ShareData {
  session: SessionInfo;
  messages: MessageWithParts[];
}

// ============================================================================
// Data fetching — uses the standard OpenCode session & message APIs
// ============================================================================

import { getActiveOpenCodeUrl } from '@/stores/server-store';

const FALLBACK_BASE_URL = `${getEnv().BACKEND_URL.replace(/\/+$/, '')}/p/kortix-sandbox/8000`;

function getOpenCodeBaseUrl(): string {
  // Use the active server URL if available (resolves correct sandboxId).
  // Only fall back to the local default for self-hosted / local mode.
  const active = getActiveOpenCodeUrl();
  return active || FALLBACK_BASE_URL;
}

async function fetchShareData(shareId: string): Promise<ShareData> {
  const baseUrl = getOpenCodeBaseUrl();
  const sessionsRes = await fetch(`${baseUrl}/session`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!sessionsRes.ok) throw new Error('Failed to load sessions');
  const contentType = sessionsRes.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Unexpected response from server');

  const sessions: SessionInfo[] = await sessionsRes.json();
  const session = sessions.find((s) => s.id.endsWith(shareId) && s.share?.url);
  if (!session) throw new Error('Share not found');

  const messagesRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!messagesRes.ok) throw new Error('Failed to load messages');
  const msgContentType = messagesRes.headers.get('content-type') || '';
  if (!msgContentType.includes('application/json')) throw new Error('Unexpected response from server');

  const messages: MessageWithParts[] = await messagesRes.json();
  return { session, messages };
}

// ============================================================================
// Share Viewer Component
// ============================================================================

export function ShareViewer({ shareId }: { shareId: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchShareData(shareId)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load share'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [shareId]);

  const parsed = useMemo(() => {
    if (!data) return null;
    const { session, messages } = data;
    const sortedMessages = [...messages].sort(
      (a, b) => a.info.time.created - b.info.time.created,
    );
    const textPartsByMessage: Record<string, MessagePart[]> = {};
    for (const msg of sortedMessages) {
      const textParts = msg.parts.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        textPartsByMessage[msg.info.id] = textParts;
      }
    }
    return { session, messages: sortedMessages, textPartsByMessage };
  }, [data]);

  // ---------- Loading state ----------
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <KortixLoader size="medium" />
          <p className="text-sm text-muted-foreground">Loading shared session...</p>
        </div>
      </div>
    );
  }

  // ---------- Error state ----------
  if (error || !parsed?.session) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="rounded-full bg-muted p-3">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="text-base font-medium">
            {error === 'Share not found' ? 'Share Not Found' : 'Error Loading Share'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {error === 'Share not found'
              ? 'This shared session does not exist or has been removed.'
              : error || 'The session data could not be loaded.'}
          </p>
        </div>
      </div>
    );
  }

  const { session, messages, textPartsByMessage } = parsed;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Header (matches Suna thread-site-header variant="shared") ── */}
      <ShareHeader sessionTitle={session.title} />

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-4 py-4 pb-0 bg-background min-h-0">
        <div className="mx-auto max-w-3xl min-w-0 w-full px-3 sm:px-6">
          <div className="space-y-6 min-w-0">
            {messages.map((msg) => {
              const parts = textPartsByMessage[msg.info.id];
              if (!parts || parts.length === 0) return null;
              return (
                <ShareMessageView
                  key={msg.info.id}
                  role={msg.info.role}
                  parts={parts}
                />
              );
            })}
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
                <p>Copy share link</p>
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

function ShareMessageView({
  role,
  parts,
}: {
  role: 'user' | 'assistant';
  parts: MessagePart[];
}) {
  const text = parts.map((p) => p.text || p.content?.text || '').join('\n').trim();
  if (!text) return null;

  if (role === 'user') {
    return <UserBubble text={text} />;
  }

  return <AssistantBlock parts={parts} aggregatedText={text} />;
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

function AssistantBlock({
  parts,
  aggregatedText,
}: {
  parts: MessagePart[];
  aggregatedText: string;
}) {
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
          {parts.map((part) => {
            const partText = part.text || part.content?.text || '';
            if (!partText.trim()) return null;
            return (
              <div key={part.id} className="break-words overflow-hidden">
                <UnifiedMarkdown content={partText} />
              </div>
            );
          })}

          {/* Message actions — Copy + Thumbs (matches Suna MessageActions) */}
          <MessageActions text={aggregatedText} />
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
