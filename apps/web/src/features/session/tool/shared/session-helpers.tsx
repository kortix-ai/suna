'use client';

import { DiffStat, STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { useToolNavigation } from '@/features/session/tool/shared/infrastructure';
import { useProjectSessionHref } from '@/lib/navigation/session-href';
import { cn } from '@/lib/utils';
import {
  ArrowSquareOutIcon as ExternalLink,
  ChatCircleIcon as MessageCircle,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import type { ParsedSessionMessage, ParsedSessionMeta } from '@kortix/shared/tool-output';
import { useEffect, useState } from 'react';

export function formatBashOutput(rawOutput: string): {
  content: string;
  lang: string;
} {
  const trimmed = rawOutput.trim();
  if (!trimmed) return { content: '', lang: 'bash' };

  try {
    const parsed = JSON.parse(trimmed);
    return { content: JSON.stringify(parsed, null, 2), lang: 'json' };
  } catch {}

  if (trimmed.includes('===') && trimmed.includes('{')) {
    const sections = trimmed.split(/^(={2,}\s.*)/m);
    let hasJson = false;
    const formatted = sections
      .flatMap((section) => {
        const st = section.trim();
        if (!st) return [];
        if (/^={2,}\s/.test(st)) return [st];
        try {
          const parsed = JSON.parse(st);
          hasJson = true;
          return [JSON.stringify(parsed, null, 2)];
        } catch {
          return [st];
        }
      })
      .join('\n\n');
    if (hasJson) return { content: formatted, lang: 'json' };
  }

  return { content: trimmed, lang: 'bash' };
}

export {
  type ParsedSessionMessage,
  type ParsedSessionMeta,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
} from '@kortix/shared/tool-output';

export function formatSessionTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const sessionTimeFallbackFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatSessionTimeFallback(timestamp: number): string {
  return sessionTimeFallbackFormat.format(new Date(timestamp));
}

export function SessionTimeLabel({ timestamp }: { timestamp: number }) {
  const [label, setLabel] = useState(() => formatSessionTimeFallback(timestamp));

  useEffect(() => {
    const update = () => setLabel(formatSessionTime(timestamp));
    update();
    const intervalId = window.setInterval(update, 60_000);
    return () => window.clearInterval(intervalId);
  }, [timestamp]);

  return <span suppressHydrationWarning>{label}</span>;
}

export function SessionMetadataList({ sessions }: { sessions: ParsedSessionMeta[] }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { enabled: navigationEnabled, openTab } = useToolNavigation();
  // `/projects/<id>/sessions/<id>`, not `/sessions/<id>` — the latter is not a
  // route and 404s on reload or Back. See `session-href.ts`.
  const sessionHref = useProjectSessionHref();

  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="text-muted-foreground px-1.5 py-1 text-xs font-medium tracking-wider uppercase">
        {sessions.length} {tI18nComplete.raw('text3f3af1ecebbd')}
        {sessions.length !== 1 ? 's' : ''}
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          disabled={!navigationEnabled}
          onClick={() =>
            openTab({
              id: s.id,
              title: s.title || 'Session',
              type: 'session',
              href: sessionHref(s.id) ?? `/projects/${s.id}`,
            })
          }
          className={cn(
            'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
            navigationEnabled
              ? 'hover:bg-muted/60 group cursor-pointer transition-colors'
              : 'group cursor-default opacity-70 transition-colors',
          )}
        >
          <MessageCircle className="text-muted-foreground group-hover:text-foreground/60 mt-0.5 size-3.5 shrink-0 transition-colors" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-foreground truncate text-xs font-medium">{s.title}</span>
              {s.summary && s.summary.files > 0 && (
                <span className="flex shrink-0 items-center gap-1.5 text-xs">
                  <DiffStat additions={s.summary.additions} deletions={s.summary.deletions} />
                  <span className="text-muted-foreground">
                    {s.summary.files} {tI18nComplete.raw('text3b9c358f36f0')}
                    {s.summary.files !== 1 ? 's' : ''}
                  </span>
                </span>
              )}
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="truncate font-mono">{s.slug || s.id}</span>
              <span className="shrink-0">
                <SessionTimeLabel timestamp={s.time.updated} />
              </span>
            </div>
          </div>
          <ExternalLink className="text-muted-foreground/0 group-hover:text-muted-foreground mt-1 size-3 shrink-0 transition-colors" />
        </button>
      ))}
    </div>
  );
}

export function InlineSessionMessagesList({ messages }: { messages: ParsedSessionMessage[] }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="text-muted-foreground px-1.5 py-1 text-xs font-medium tracking-wider uppercase">
        {messages.length} {tHardcodedUi.raw('i18nComplete.textab530a13e459')}
        {messages.length !== 1 ? 's' : ''}
      </div>
      {messages.map((msg) => (
        <div
          key={msg.index}
          className={cn(
            // `rounded-md`, not `rounded-2xl`: this card nests inside the bash
            // tool's own `rounded-md` command card, and a 16px radius inside an
            // 8px one reads as a pill dropped into a panel. The conformance
            // sweep only scans `tool/tools/`, so this file never caught it.
            'overflow-hidden rounded-md border',
            msg.role === 'user' ? 'border-border/60' : 'border-border/40',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 px-2.5 py-1',
              msg.role === 'user' ? 'bg-muted/50' : 'bg-card',
            )}
          >
            <span
              className={cn(
                'text-xs font-semibold tracking-wide uppercase',
                msg.role === 'user' ? STATUS_TEXT.info : STATUS_TEXT.success,
              )}
            >
              {msg.role}
            </span>
            <span className="text-muted-foreground/50 ml-auto text-xs">#{msg.index}</span>
            {msg.cost > 0 && (
              <span className="text-muted-foreground/50 text-xs">${msg.cost.toFixed(4)}</span>
            )}
          </div>
          <div className="px-2.5 py-1.5">
            <div className="text-foreground/90 text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
              {msg.content.slice(0, 800)}
              {msg.content.length > 800 && (
                <span className="text-muted-foreground/50">
                  {' '}
                  {tHardcodedUi.raw('componentsSessionToolRenderers.line2350JsxTextTruncated')}
                </span>
              )}
            </div>
            {msg.tools && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {msg.tools.split(',').map((t, i) => {
                  const trimmedTool = t.trim();
                  const nameMatch = trimmedTool.match(/^(\w+)\s*\((\w+)\)/);
                  const name = nameMatch?.[1] || trimmedTool;
                  const toolStatus = nameMatch?.[2] || '';
                  return (
                    <span
                      key={i}
                      className={cn(
                        'rounded border px-1 py-0.5 text-xs',
                        toolStatus === 'completed'
                          ? cn(STATUS_BG.success, STATUS_BORDER.success, STATUS_TEXT.success)
                          : 'bg-muted/50 border-border/50 text-muted-foreground',
                      )}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
