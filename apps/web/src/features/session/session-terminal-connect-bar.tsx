'use client';

import { cn } from '@/lib/utils';
import { Check, ChevronRight, Copy, Laptop } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A slim strip that lives at the top of the session Terminal panel and tells the
 * user how to open the same ACP conversation from their local terminal with
 * the Kortix CLI. Deliberately not its own tab: it rides beside the live shell
 * while remaining independent of the selected Claude/Codex/OpenCode/Pi harness.
 *
 * Collapsed, it shows just the one command that matters (`kortix sessions
 * connect <id>`) with a copy button. Expanded, it adds the one-time install
 * step and a one-line explainer.
 */
export function SessionTerminalConnectBar({ projectSessionId }: { projectSessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const connectCmd = `kortix sessions connect ${projectSessionId}`;
  const installCmd = 'npm i -g @kortix/cli';

  return (
    <div className="shrink-0 border-b border-white/10 bg-[#15151d] text-[13px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/60 transition-colors hover:text-white/80"
        aria-expanded={expanded}
      >
        <Laptop className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 font-medium">Connect from your machine</span>
        <span className="min-w-0 flex-1 truncate font-mono text-white/35">{connectCmd}</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-2.5 px-3 pb-3 pt-0.5">
          <p className="text-xs leading-relaxed text-white/45">
            Continue this session&apos;s authenticated ACP conversation from your terminal. The CLI
            reconnects to the same persisted transcript; no harness-specific client is required.
          </p>
          <CommandRow label="1. Install the CLI (once)" command={installCmd} />
          <CommandRow label="2. Attach to this session" command={connectCmd} />
        </div>
      )}
    </div>
  );
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [command]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-white/35">{label}</div>
      <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-white/80">{command}</code>
        <button
          type="button"
          onClick={copy}
          className="relative inline-flex size-7 shrink-0 items-center justify-center rounded text-white/40 transition-[color,background-color,scale] after:absolute after:-inset-1.5 hover:bg-white/10 hover:text-white/80 active:scale-[0.96]"
          aria-label={copied ? 'Copied' : 'Copy command'}
        >
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={copied ? 'check' : 'copy'}
                initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {copied ? (
                  <Check className="text-kortix-green size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
        </button>
      </div>
    </div>
  );
}
