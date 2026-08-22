'use client';

import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { cn } from '@/lib/utils';
import {
  CheckIcon as Check,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  LaptopIcon as Laptop,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A slim strip that lives at the top of the session Terminal panel and tells the
 * user how to attach their *local* OpenCode TUI to this session's sandbox with
 * the Kortix CLI. Deliberately NOT its own tab — it rides along with the live
 * terminal so "how do I get a shell into this from my machine?" is answered
 * right where a shell already lives.
 *
 * Collapsed, it teases the one command that works on any machine — the
 * one-time CLI install. Expanded, it shows the full two-step flow:
 * 1. install, 2. `kortix sessions connect <id>`.
 */
export function SessionTerminalConnectBar({ projectSessionId }: { projectSessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const connectCmd = `kortix sessions connect ${projectSessionId}`;
  const installCmd = useDeploymentCliInstallCommand(undefined);

  return (
    <div className="border-terminal-border bg-terminal-surface shrink-0 border-b text-[13px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-terminal-fg/60 hover:text-terminal-fg/85 flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left transition-colors"
        aria-expanded={expanded}
      >
        <Laptop className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 font-medium">Connect from your machine</span>
        <span className="text-terminal-fg/40 min-w-0 flex-1 truncate font-mono">{installCmd}</span>
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
        <div className="space-y-2.5 px-3 pt-0.5 pb-3">
          <p className="text-terminal-fg/50 text-xs leading-relaxed">
            Attach your local OpenCode TUI straight to this session&apos;s sandbox. The CLI opens a
            local proxy, injects your Kortix token, then runs{' '}
            <span className="text-terminal-fg/70 font-mono">opencode attach</span>.
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
      <div className="text-terminal-fg/40 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </div>
      <div className="border-terminal-border bg-terminal-fg/[0.06] flex items-center gap-2 rounded-md border px-2.5 py-1">
        <code className="text-terminal-fg/90 min-w-0 flex-1 truncate font-mono">{command}</code>
        {/* `after:-inset-1.5` lifts the 28px control to a 40px hit area
            without growing the row it sits in. */}
        <button
          type="button"
          onClick={copy}
          className="text-terminal-fg/50 hover:bg-terminal-fg/10 hover:text-terminal-fg/90 relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-[background-color,transform] after:absolute after:-inset-1.5 after:content-[''] active:scale-[0.96]"
          aria-label={copied ? 'Copied' : 'Copy command'}
        >
          {copied ? (
            <Check className="text-kortix-green h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
