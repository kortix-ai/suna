'use client';

import { memo, useRef, useEffect, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { Terminal as XTerm, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useAuth } from '@/components/AuthProvider';
import { Loader2, RefreshCw, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { backendApi } from '@/lib/api-client';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';

interface SSHTerminalProps {
  sandboxId: string;
  className?: string;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const darkTheme: ITheme = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#787c99',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
};

const lightTheme: ITheme = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526eff',
  cursorAccent: '#fafafa',
  selectionBackground: '#bfceff',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#d19a66',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

const getWebSocketUrl = () => {
  const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
  return baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
};

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
  const [sshCommand, setSshCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidateFileQueries = useCallback(() => {
    if (invalidateTimeoutRef.current) {
      clearTimeout(invalidateTimeoutRef.current);
    }
    invalidateTimeoutRef.current = setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.directories(),
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
              term.write(message.data);
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

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme: isDark ? darkTheme : lightTheme,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();
    
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln('\x1b[1;34m╔════════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[1;34m║\x1b[0m         \x1b[1;36mKortix Terminal\x1b[0m                \x1b[1;34m║\x1b[0m');
    term.writeln('\x1b[1;34m╚════════════════════════════════════════╝\x1b[0m');
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

    const handleResize = () => fitAddonRef.current?.fit();
    window.addEventListener('resize', handleResize);
    
    const container = terminalRef.current;
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      if (invalidateTimeoutRef.current) {
        clearTimeout(invalidateTimeoutRef.current);
      }
      disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
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
    if (!session?.access_token || !sandboxId || !xtermRef.current || wsRef.current) {
      return;
    }
    
    console.log('[SSHTerminal] Initiating connection...');
    getSSHCommand();
    connectWebSocket(session.access_token, xtermRef.current);
  }, [session?.access_token, sandboxId, getSSHCommand, connectWebSocket]);

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <div className="flex items-center justify-between h-8 px-3 bg-zinc-100 dark:bg-[#24283b] border-b border-zinc-200 dark:border-[#414868] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-2 h-2 rounded-full",
            status === 'connected' && "bg-green-500",
            status === 'connecting' && "bg-yellow-500 animate-pulse",
            status === 'disconnected' && "bg-zinc-400 dark:bg-zinc-500",
            status === 'error' && "bg-red-500"
          )} />
          <span className="text-zinc-500 dark:text-[#565f89] text-xs">
            {status === 'connected' && 'Connected'}
            {status === 'connecting' && 'Connecting...'}
            {status === 'disconnected' && 'Disconnected'}
            {status === 'error' && 'Connection Error'}
          </span>
        </div>
        
        <div className="flex items-center gap-1">
          {sshCommand && (
            <button
              onClick={copySSHCommand}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-blue-600 dark:text-[#7aa2f7] hover:bg-zinc-200 dark:hover:bg-[#414868] rounded transition-colors"
              title="Copy SSH command for local terminal"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span className="hidden sm:inline">SSH</span>
            </button>
          )}
          
          {status === 'connecting' && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-[#7aa2f7]" />
          )}
          
          {(status === 'disconnected' || status === 'error') && (
            <button
              onClick={reconnect}
              className="p-1 hover:bg-zinc-200 dark:hover:bg-[#414868] rounded transition-colors"
              title="Reconnect"
            >
              <RefreshCw className="w-3.5 h-3.5 text-blue-600 dark:text-[#7aa2f7]" />
            </button>
          )}
        </div>
      </div>
      
      <div 
        ref={terminalRef}
        className="flex-1 bg-[#fafafa] dark:bg-[#1a1b26] overflow-hidden"
        style={{ padding: '8px' }}
      />
    </div>
  );
});

SSHTerminal.displayName = 'SSHTerminal';
