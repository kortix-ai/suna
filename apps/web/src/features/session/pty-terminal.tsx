'use client';

import { cn } from '@/lib/utils';
import type { Pty } from '@kortix/sdk';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ITheme, Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { RefObject } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { PtyAttachStatus } from './pty-attach-status';
import type { ConnectionStatus } from './pty-connection';
import { usePtyConnection } from './use-pty-connection';

export { isTerminalReport, sanitizeTerminalChunk } from './pty-terminal-sanitize';

// ============================================================================
// Theme
// ============================================================================

// Neutral (zero-chroma) surface matching the app's dark background — no blue
// tint. Selection stays neutral so it reads on any ANSI color underneath.
//
// `background` and `foreground` MUST stay equal to `--terminal-surface` and
// `--terminal-fg` in globals.css — the xterm container paints those tokens
// around the canvas, and xterm's ITheme only accepts literal colors, never vars.
const terminalTheme: ITheme = {
  background: '#0f0f0f',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0f0f0f',
  selectionBackground: 'rgba(255, 255, 255, 0.18)',
  black: '#262626',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#525252',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

// ============================================================================
// Types
// ============================================================================

// xterm's default is 1000 lines — a single `npm install` or test run scrolls
// past that, and the buffer is the only place that output exists client-side.
const PTY_SCROLLBACK_LINES = 10_000;

export interface PtyTerminalHandle {
  focus: () => void;
  kill: () => void;
}

interface PtyTerminalProps {
  pty: Pty;
  className?: string;
  hidden?: boolean;
  /** Server URL to connect to — locks the WS to this server even after instance switch. */
  serverUrl?: string;
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called when reconnecting this ID can never work (daemon no longer owns it). */
  onUnavailable?: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely call fitAddon.fit() only when the container has real dimensions. */
function safeFit(fitAddon: FitAddon | null, container: HTMLDivElement | null) {
  if (!fitAddon || !container) return;
  const { offsetWidth, offsetHeight } = container;
  if (offsetWidth > 0 && offsetHeight > 0) {
    try {
      fitAddon.fit();
    } catch {
      // Ignore – xterm may not be fully initialised yet
    }
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Creates the xterm instance and its resize plumbing. Owns nothing about the
 * socket: the attach lifecycle lives in `usePtyConnection`. Re-runs on the
 * same (pty, serverUrl) trigger as the connection, so a sandbox move rebuilds
 * both the terminal and its socket.
 */
function usePtyTerminalXterm(
  pty: Pty,
  serverUrl: string | undefined,
  xtermRef: RefObject<XTerm | null>,
  handleData: (data: string) => void,
  sendResize: (cols: number, rows: number) => void,
) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize xterm (the attach lifecycle lives in usePtyConnection)
  useEffect(() => {
    if (!terminalRef.current) return;

    const container = terminalRef.current;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme: terminalTheme,
      scrollback: PTY_SCROLLBACK_LINES,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(container);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData(handleData);

    // Handle resize — notify the PTY server
    term.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    // Responsive resize with dimension guard
    const handleResize = () => safeFit(fitAddonRef.current, container);
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => safeFit(fitAddonRef.current, container));
    });
    resizeObserver.observe(container);

    // Delay fit to ensure the container has real dimensions — the connection's
    // first dial runs on the same beat (see usePtyConnection).
    const initTimer = setTimeout(() => {
      safeFit(fitAddon, container);
    }, 80);

    return () => {
      clearTimeout(initTimer);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [pty.id, serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { terminalRef, fitAddonRef };
}

export const PtyTerminal = forwardRef<PtyTerminalHandle, PtyTerminalProps>(function PtyTerminal(
  { pty, className, hidden, serverUrl, onStatusChange, onUnavailable },
  ref,
) {
  const xtermRef = useRef<XTerm | null>(null);

  const {
    phase,
    hasConnected,
    phaseRef,
    reconnectNow,
    kill,
    sendResize,
    handleData,
  } = usePtyConnection(pty, serverUrl, xtermRef, { onStatusChange, onUnavailable });
  const xtermRefs = usePtyTerminalXterm(pty, serverUrl, xtermRef, handleData, sendResize);
  const { terminalRef, fitAddonRef } = xtermRefs;

  useImperativeHandle(ref, () => ({
    focus: () => {
      xtermRef.current?.focus();
    },
    kill,
  }));

  // Re-fit and focus when becoming visible (tab switch)
  useEffect(() => {
    if (hidden) return;
    // Showing a paused terminal again is a request for the shell.
    if (phaseRef.current === 'asleep' || phaseRef.current === 'failed') {
      reconnectNow();
    }
    requestAnimationFrame(() => {
      safeFit(fitAddonRef.current, terminalRef.current);
      // Never steal focus on a touch device: the mobile tool drawer mounts this
      // with `hidden` undefined, and focusing xterm there throws up the
      // on-screen keyboard over the terminal on every open.
      if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
        return;
      }
      xtermRef.current?.focus();
    });
  // The refs arrive from the two hooks above, so the rule cannot see they are
  // stable boxes; `reconnectNow` is a stable callback. Nothing here re-runs on
  // a phase change: the check reads the CURRENT phase at visibility time.
  }, [hidden, reconnectNow]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={cn(
        'bg-terminal-surface relative overflow-hidden',
        hidden && 'pointer-events-none invisible',
        className,
      )}
    >
      <div
        ref={terminalRef}
        className={cn('h-full w-full px-3 py-2', !hasConnected && 'opacity-0')}
      />
      {phase && !hidden ? (
        <PtyAttachStatus
          phase={phase}
          hasConnected={hasConnected}
          onAction={() => reconnectNow()}
        />
      ) : null}
    </div>
  );
});

PtyTerminal.displayName = 'PtyTerminal';
