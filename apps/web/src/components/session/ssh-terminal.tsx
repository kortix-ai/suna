'use client';

import { memo, useRef, useEffect, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import type { Terminal as XTerm, ITheme } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useAuth } from '@/components/AuthProvider';
import { RefreshCw, Copy, Check, TerminalSquare } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { toast } from '@/lib/toast';
import { getEnv } from '@/lib/env-config';
import { backendApi } from '@/lib/api-client';
import { fileListKeys } from '@/features/files';

interface SSHTerminalProps {
  sandboxId: string;
  className?: string;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const darkTheme: ITheme = {
  background: 'rgba(15, 15, 20, 0.85)',
  foreground: '#e4e4e7',
  cursor: '#a78bfa',
  cursorAccent: '#0f0f14',
  selectionBackground: 'rgba(139, 92, 246, 0.3)',
  black: '#27272a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const lightTheme: ITheme = {
  background: 'rgba(250, 250, 252, 0.9)',
  foreground: '#18181b',
  cursor: '#7c3aed',
  cursorAccent: '#fafafc',
  selectionBackground: 'rgba(124, 58, 237, 0.15)',
  black: '#18181b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#a1a1aa',
  brightBlack: '#52525b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
};

const getWebSocketUrl = () => {
  const baseUrl = getEnv().BACKEND_URL || 'http://localhost:8008';
  return baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
};

function sanitizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\x1b]697;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\{"cursor":\d+\}/g, '');
}

let globalConnectionId = 0;

export const SSHTerminal = memo(function SSHTerminal({ sandboxId, className }: SSHTerminalProps) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef<number>(0);
  const invalidateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [termReady, setTermReady] = useState(false);
  const [sshCommand, setSshCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidateFileQueries = useCallback(() => {
    if (invalidateTimeoutRef.current) {
      clearTimeout(invalidateTimeoutRef.current);
    }
    invalidateTimeoutRef.current = setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.all,
      });
    }, 500);
  }, [queryClient]);

  const getSSHCommand = useCallback(async () => {
    if (!sandboxId) return;
    try {
      const response = await backendApi.post<{ ssh_command: string; token: string }>(
        `/sandboxes/${sandboxId}/ssh/token`,
        { expires_in_minutes: 60 }
      );
      if (response.data?.ssh_command) {
        setSshCommand(response.data.ssh_command);
      }
    } catch (error) {
      console.error('Failed to get SSH command:', error);
    }
  }, [sandboxId]);

  const copySSHCommand = useCallback(() => {
    if (sshCommand) {
      navigator.clipboard.writeText(sshCommand);
      setCopied(true);
      toast.success('SSH command copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    }
  }, [sshCommand]);

  const disconnect = useCallback(() => {
    connectionIdRef.current = 0;
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  }, []);

  const connectWebSocket = useCallback((accessToken: string, term: XTerm) => {
    if (wsRef.current) {
      console.log('[SSHTerminal] Already have a WebSocket, skipping');
      return;
    }

    globalConnectionId++;
    const myConnectionId = globalConnectionId;
    connectionIdRef.current = myConnectionId;

    setStatus('connecting');
    
    const wsUrl = getWebSocketUrl();
    console.log('[Terminal] Creating WebSocket (id:', myConnectionId, '):', `${wsUrl}/sandboxes/${sandboxId}/terminal/ws`);
    
    const ws = new WebSocket(`${wsUrl}/sandboxes/${sandboxId}/terminal/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (connectionIdRef.current !== myConnectionId) {
        console.log('[SSHTerminal] Stale connection, closing');
        ws.close();
        return;
      }
      console.log('[SSHTerminal] WebSocket open, sending auth...');
      try {
        ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }));
        console.log('[SSHTerminal] Auth sent');
      } catch (e) {
        console.error('[SSHTerminal] Failed to send auth:', e);
        setStatus('error');
      }
    };

    ws.onmessage = (event) => {
      if (connectionIdRef.current !== myConnectionId) return;
      
      try {
        const message = JSON.parse(event.data);
        console.log('[SSHTerminal] Message:', message.type, message.message || '');
        
        switch (message.type) {
          case 'status':
            term.writeln(`\x1b[33m${message.message}\x1b[0m`);
            break;
          case 'connected':
            setStatus('connected');
            term.writeln(`\x1b[32m${message.message}\x1b[0m`);
            term.writeln('');
            break;
          case 'output':
            if (message.data) {
              term.write(sanitizeTerminalChunk(message.data));
            }
            break;
          case 'error':
            setStatus('error');
            term.writeln(`\x1b[31mError: ${message.message}\x1b[0m`);
            break;
          case 'exit':
            term.writeln(`\x1b[33mSession ended with code: ${message.code}\x1b[0m`);
            setStatus('disconnected');
            wsRef.current = null;
            break;
        }
      } catch (e) {
        console.error('[SSHTerminal] Parse error:', e);
      }
    };

    ws.onerror = (error) => {
      if (connectionIdRef.current !== myConnectionId) return;
      console.error('[SSHTerminal] WebSocket error:', error);
      setStatus('error');
    };

    ws.onclose = (event) => {
      if (connectionIdRef.current !== myConnectionId) return;
      console.log('[SSHTerminal] WebSocket closed:', event.code);
      wsRef.current = null;
      setStatus('disconnected');
      term.writeln('\x1b[33mConnection closed\x1b[0m');
    };
  }, [sandboxId]);

  const reconnect = useCallback(() => {
    disconnect();
    
    if (xtermRef.current && session?.access_token) {
      xtermRef.current.clear();
      xtermRef.current.writeln('\x1b[33mReconnecting...\x1b[0m');
      
      setTimeout(() => {
        if (xtermRef.current) {
          connectWebSocket(session.access_token, xtermRef.current);
        }
      }, 300);
    }
  }, [disconnect, session?.access_token, connectWebSocket]);

  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let term: XTerm | null = null;
    let handleResize: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const container = terminalRef.current;

    // Dynamically import xterm modules to avoid SSR issues (they reference `self`)
    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      // @ts-expect-error -- CSS module has no type declarations
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xtermModule, fitModule, webLinksModule]) => {
      if (disposed || !container) return;

      term = new xtermModule.Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 13,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
        theme: isDark ? darkTheme : lightTheme,
        allowProposedApi: true,
      });

      const fitAddon = new fitModule.FitAddon();
      const webLinksAddon = new webLinksModule.WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);

      term.open(container);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      term.writeln('\x1b[38;5;141m┌──────────────────────────────────────────┐\x1b[0m');
      term.writeln('\x1b[38;5;141m│\x1b[0m   \x1b[1;38;5;183m◉\x1b[0m \x1b[1;37mKortix\x1b[0m \x1b[38;5;245m• Terminal\x1b[0m               \x1b[38;5;141m│\x1b[0m');
      term.writeln('\x1b[38;5;141m└──────────────────────────────────────────┘\x1b[0m');
      term.writeln('');

      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data }));
          if (data.includes('\r') || data.includes('\n')) {
            invalidateFileQueries();
          }
        }
      });

      term.onResize(({ cols, rows }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      handleResize = () => fitAddonRef.current?.fit();
      window.addEventListener('resize', handleResize);

      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);

      setTermReady(true);
    });

    return () => {
      disposed = true;
      setTermReady(false);
      if (handleResize) window.removeEventListener('resize', handleResize);
      if (resizeObserver) resizeObserver.disconnect();
      if (invalidateTimeoutRef.current) {
        clearTimeout(invalidateTimeoutRef.current);
      }
      disconnect();
      if (term) term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnect, invalidateFileQueries]);

  useEffect(() => {
    if (fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 100);
    }
  }, []);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = isDark ? darkTheme : lightTheme;
    }
  }, [isDark]);

  useEffect(() => {
    if (!session?.access_token || !sandboxId || !xtermRef.current || !termReady || wsRef.current) {
      return;
    }

    console.log('[SSHTerminal] Initiating connection...');
    getSSHCommand();
    connectWebSocket(session.access_token, xtermRef.current);
  }, [session?.access_token, sandboxId, termReady, getSSHCommand, connectWebSocket]);

  return (
    <div className={cn(
      "flex flex-col h-full overflow-hidden",
      "bg-white/50 dark:bg-zinc-900/50",
      className
    )}>
      <div 
        ref={terminalRef}
        className={cn(
          "flex-1 overflow-hidden",
          "bg-gradient-to-b from-zinc-50 to-white dark:from-[#0f0f14] dark:to-[#0a0a0d]"
        )}
        style={{ padding: '12px 16px' }}
      />
    </div>
  );
});

SSHTerminal.displayName = 'SSHTerminal';
