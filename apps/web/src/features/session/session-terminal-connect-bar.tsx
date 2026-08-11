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
export function SessionTerminalConnectBar({ workspaceSessionId }: { workspaceSessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const connectCmd = `kortix sessions connect ${workspaceSessionId}`;
  const installCmd = useDeploymentCliInstallCommand(undefined);

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
        <span className="min-w-0 flex-1 truncate font-mono text-white/35">{installCmd}</span>
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
        <div className="space-y-2.5 px-3 pt-0.5 pb-3">
          <p className="text-xs leading-relaxed text-white/45">
            Attach your local OpenCode TUI straight to this session&apos;s sandbox. The CLI opens a
            local proxy, injects your Kortix token, then runs{' '}
            <span className="font-mono text-white/60">opencode attach</span>.
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
      <div className="text-[11px] font-medium tracking-wide text-white/35 uppercase">{label}</div>
      <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-white/80">{command}</code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
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
