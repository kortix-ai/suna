/**
 * TerminalPage — Full terminal emulator for the mobile app.
 *
 * Uses the OpenCode PTY protocol (same as the frontend PtyTerminal):
 * 1. POST {sandboxUrl}/pty — create a new PTY session
 * 2. WebSocket at wss://{sandboxUrl}/pty/{ptyId}/connect?token={jwt} — raw data
 * 3. PATCH {sandboxUrl}/pty/{ptyId} — resize notifications
 * 4. DELETE {sandboxUrl}/pty/{ptyId} — cleanup on unmount
 *
 * The WebView runs xterm.js and the WebSocket URL + token are baked into the
 * HTML so it auto-connects on load (no postMessage race conditions).
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Keyboard,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as Haptics from 'expo-haptics';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TerminalPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface PtyInfo {
  id: string;
  command?: string;
  title?: string;
}

// ─── PTY API helpers ─────────────────────────────────────────────────────────

async function createPty(sandboxUrl: string): Promise<PtyInfo> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/pty`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to create PTY: ${res.status} ${body}`);
  }
  return res.json();
}

async function removePty(sandboxUrl: string, ptyId: string): Promise<void> {
  const token = await getAuthToken();
  await fetch(`${sandboxUrl}/pty/${ptyId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
}

async function resizePty(
  sandboxUrl: string,
  ptyId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const token = await getAuthToken();
  await fetch(`${sandboxUrl}/pty/${ptyId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ size: { cols, rows } }),
  }).catch(() => {});
}

/** Convert sandboxUrl (http/https) to a WebSocket URL for PTY connect. */
function getPtyWsUrl(sandboxUrl: string, ptyId: string, token: string): string {
  let wsUrl: string;
  try {
    const parsed = new URL(sandboxUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = parsed.toString().replace(/\/+$/, '');
  } catch {
    wsUrl = sandboxUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  }
  return `${wsUrl}/pty/${ptyId}/connect?token=${encodeURIComponent(token)}`;
}

// ─── Terminal HTML builder ───────────────────────────────────────────────────

function buildTerminalHtml(params: {
  wsUrl: string;
  sandboxUrl: string;
  ptyId: string;
}): string {
  const { wsUrl, sandboxUrl, ptyId } = params;
  // Terminal is always dark, matching the web frontend
  const isDark = true;
  const bg = '#0f0f14';

  // Escape for safe JS string embedding
  const safeWsUrl = wsUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const safeSandboxUrl = sandboxUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const safePtyId = ptyId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: ${bg};
    }
    #terminal {
      width: 100%;
      height: 100%;
      padding: 8px 4px;
    }
    .xterm { height: 100%; }
    .xterm-viewport { overflow-y: auto !important; }
    .xterm-viewport::-webkit-scrollbar { width: 4px; }
    .xterm-viewport::-webkit-scrollbar-thumb {
      background: ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"><\/script>
  <script>
    (function() {
      var WS_URL = '${safeWsUrl}';
      var SANDBOX_URL = '${safeSandboxUrl}';
      var PTY_ID = '${safePtyId}';

      var ws = null;
      var term = null;
      var fitAddon = null;
      var resizeTimer = null;

      function postMsg(type, data) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, data: data }));
        } catch(e) {}
      }

      function connect() {
        if (ws) {
          try { ws.close(); } catch(e) {}
          ws = null;
        }

        postMsg('status', 'connecting');

        try {
          ws = new WebSocket(WS_URL);
        } catch(e) {
          postMsg('status', 'error');
          if (term) term.writeln('\\x1b[31mFailed to create WebSocket: ' + e.message + '\\x1b[0m');
          return;
        }

        ws.onopen = function() {
          postMsg('status', 'connected');

          // Send initial size
          if (term) {
            postMsg('resize', { cols: term.cols, rows: term.rows });
          }

          // Set up colors and clear setup noise (same as frontend PtyTerminal)
          var init = [
            'export TERM=xterm-256color',
            'export COLORTERM=truecolor',
            'export CLICOLOR=1',
            'alias ls="ls --color=auto" 2>/dev/null',
            'alias grep="grep --color=auto"',
            'clear'
          ].join(' && ');
          ws.send(init + '\\n');
        };

        ws.onmessage = function(event) {
          if (!term) return;
          // PTY protocol sends raw terminal data (not JSON)
          if (typeof event.data === 'string') {
            term.write(event.data);
          } else if (event.data instanceof Blob) {
            event.data.text().then(function(text) {
              term.write(text);
            });
          }
        };

        ws.onerror = function() {
          postMsg('status', 'error');
          if (term) term.writeln('\\x1b[31mWebSocket error\\x1b[0m');
        };

        ws.onclose = function(event) {
          ws = null;
          postMsg('status', 'disconnected');
          if (term) {
            term.writeln('\\x1b[33mConnection closed' + (event.code ? ' (code ' + event.code + ')' : '') + '\\x1b[0m');
          }
        };
      }

      function initTerminal() {
        try {
          var isDark = ${isDark ? 'true' : 'false'};

          term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: 14,
            lineHeight: 1.2,
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            theme: isDark ? {
              background: '${bg}',
              foreground: '#e4e4e7',
              cursor: '#e4e4e7',
              cursorAccent: '#0f0f14',
              selectionBackground: 'rgba(139, 92, 246, 0.3)',
              black: '#27272a', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
              blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7',
              brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac',
              brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
              brightCyan: '#67e8f9', brightWhite: '#fafafa'
            } : {
              background: '${bg}',
              foreground: '#18181b',
              cursor: '#7c3aed',
              cursorAccent: '#fafafc',
              selectionBackground: 'rgba(124, 58, 237, 0.15)',
              black: '#18181b', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
              blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#a1a1aa',
              brightBlack: '#52525b', brightRed: '#ef4444', brightGreen: '#22c55e',
              brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
              brightCyan: '#06b6d4', brightWhite: '#fafafa'
            },
            allowProposedApi: true,
            scrollback: 5000,
            convertEol: true
          });

          fitAddon = new FitAddon.FitAddon();
          term.loadAddon(fitAddon);
          term.open(document.getElementById('terminal'));

          setTimeout(function() {
            try { fitAddon.fit(); } catch(e) {}
          }, 100);

          // User input => raw WebSocket send (PTY protocol uses raw data)
          term.onData(function(data) {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            }
          });

          // Resize => notify RN to PATCH the PTY
          term.onResize(function(size) {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function() {
              postMsg('resize', { cols: size.cols, rows: size.rows });
            }, 100);
          });

          // Refit on viewport changes
          var fitTimer = null;
          function debouncedFit() {
            clearTimeout(fitTimer);
            fitTimer = setTimeout(function() {
              try { fitAddon.fit(); } catch(e) {}
            }, 100);
          }
          window.addEventListener('resize', debouncedFit);
          new ResizeObserver(debouncedFit).observe(document.getElementById('terminal'));

          postMsg('ready', {});

          // Auto-connect
          connect();

        } catch(e) {
          postMsg('status', 'error');
          postMsg('log', 'Init error: ' + e.message);
        }
      }

      // Listen for RN messages (reconnect / refit)
      function handleRNMessage(e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'reconnect') {
            if (term) term.clear();
            connect();
          } else if (msg.type === 'refit') {
            if (fitAddon) {
              setTimeout(function() { try { fitAddon.fit(); } catch(e) {} }, 50);
            }
          }
        } catch(e) {}
      }
      window.addEventListener('message', handleRNMessage);
      document.addEventListener('message', handleRNMessage);

      // Wait for CDN scripts then init
      function waitForXterm() {
        if (typeof Terminal !== 'undefined' && typeof FitAddon !== 'undefined') {
          initTerminal();
        } else {
          setTimeout(waitForXterm, 50);
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForXterm);
      } else {
        waitForXterm();
      }
    })();
  <\/script>
</body>
</html>`;
}

// ─── TerminalPage ────────────────────────────────────────────────────────────

export function TerminalPage({ page, onBack, onOpenDrawer, onOpenRightDrawer }: TerminalPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { sandboxUrl } = useSandboxContext();

  const webViewRef = useRef<WebView>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [webViewReady, setWebViewReady] = useState(false);
  const [terminalHtml, setTerminalHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);

  // Track current PTY for cleanup
  const ptyRef = useRef<{ id: string; sandboxUrl: string } | null>(null);

  // Header follows system theme; terminal body is always dark
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const headerBg = isDark ? '#121215' : '#F8F8F8';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  // Terminal area is always dark
  const terminalBg = '#0f0f14';
  const themeColors = useThemeColors();

  // Create PTY, build HTML with baked-in connection params
  useEffect(() => {
    if (!sandboxUrl) return;
    let cancelled = false;

    (async () => {
      try {
        setError(null);
        setTerminalHtml(null);

        // 1. Get auth token
        const token = await getAuthToken();
        if (cancelled || !token) {
          if (!cancelled) setError('No auth token');
          return;
        }

        // 2. Create a new PTY session
        log.log('[TerminalPage] Creating PTY on:', sandboxUrl);
        const pty = await createPty(sandboxUrl);
        if (cancelled) {
          removePty(sandboxUrl, pty.id);
          return;
        }
        log.log('[TerminalPage] PTY created:', pty.id);
        ptyRef.current = { id: pty.id, sandboxUrl };

        // 3. Build WebSocket URL
        const wsUrl = getPtyWsUrl(sandboxUrl, pty.id, token);
        log.log('[TerminalPage] WS URL:', wsUrl);

        // 4. Build HTML
        const html = buildTerminalHtml({
          wsUrl,
          sandboxUrl,
          ptyId: pty.id,
        });

        if (!cancelled) {
          setTerminalHtml(html);
        }
      } catch (err: any) {
        log.error('[TerminalPage] Setup error:', err?.message || err);
        if (!cancelled) setError(err?.message || 'Failed to create terminal');
      }
    })();

    return () => {
      cancelled = true;
      // Cleanup PTY on unmount
      if (ptyRef.current) {
        const { id, sandboxUrl: url } = ptyRef.current;
        log.log('[TerminalPage] Cleaning up PTY:', id);
        removePty(url, id);
        ptyRef.current = null;
      }
    };
  }, [sandboxUrl, webViewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle messages from the WebView
  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        switch (msg.type) {
          case 'ready':
            setWebViewReady(true);
            break;
          case 'status':
            setStatus(msg.data as ConnectionStatus);
            break;
          case 'resize':
            // Forward resize to PTY via HTTP PATCH
            if (ptyRef.current && sandboxUrl && msg.data?.cols && msg.data?.rows) {
              resizePty(sandboxUrl, ptyRef.current.id, msg.data.cols, msg.data.rows);
            }
            break;
          case 'log':
            log.log('[TerminalPage/WebView]', msg.data);
            break;
        }
      } catch {
        // ignore
      }
    },
    [sandboxUrl],
  );

  // Reconnect: clean up old PTY, bump key to create a new one
  const handleReconnect = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Cleanup old PTY
    if (ptyRef.current) {
      removePty(ptyRef.current.sandboxUrl, ptyRef.current.id);
      ptyRef.current = null;
    }
    setStatus('disconnected');
    setWebViewReady(false);
    setTerminalHtml(null);
    setError(null);
    setWebViewKey((k) => k + 1);
  }, []);

  // Refit terminal on keyboard show/hide
  useEffect(() => {
    const refit = () => {
      setTimeout(() => {
        webViewRef.current?.postMessage(JSON.stringify({ type: 'refit' }));
      }, 300);
    };
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      refit,
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      refit,
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Status indicator
  const statusColor =
    status === 'connected'
      ? '#4ade80'
      : status === 'connecting'
        ? '#fbbf24'
        : status === 'error'
          ? '#f87171'
          : mutedColor;

  const statusLabel =
    status === 'connected'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting...'
        : status === 'error'
          ? 'Error'
          : 'Disconnected';

  return (
    <View style={{ flex: 1, backgroundColor: terminalBg }}>
      <PageHeader
        title="Terminal"
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        rightActions={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* Status indicator */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 4 }}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: statusColor,
                  marginRight: 6,
                }}
              />
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor }}>
                {statusLabel}
              </Text>
            </View>
            {/* Reconnect button */}
            <TouchableOpacity
              onPress={handleReconnect}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ padding: 6 }}
            >
              <Ionicons name="refresh-outline" size={18} color={fgColor} />
            </TouchableOpacity>
          </View>
        }
      />

      <PageContent backgroundColor={terminalBg}>
      {/* Content */}
      {!sandboxUrl ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="terminal-outline" size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor }}>
            No sandbox available
          </Text>
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Ionicons name="alert-circle-outline" size={32} color="#f87171" style={{ marginBottom: 12 }} />
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fgColor, marginBottom: 4, textAlign: 'center' }}>
            Terminal Error
          </Text>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center', marginBottom: 16 }}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={handleReconnect}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: themeColors.primary,
              borderRadius: 8,
              paddingHorizontal: 16,
              paddingVertical: 8,
            }}
          >
            <Ionicons name="refresh-outline" size={14} color={themeColors.primaryForeground} style={{ marginRight: 6 }} />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !terminalHtml ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={mutedColor} />
          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, marginTop: 12 }}>
            Starting terminal...
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ html: terminalHtml }}
            style={{ flex: 1, backgroundColor: terminalBg, opacity: webViewReady ? 1 : 0 }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            onMessage={handleWebViewMessage}
            scrollEnabled
            bounces={false}
            overScrollMode="never"
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            textInteractionEnabled={false}
            allowsInlineMediaPlayback
            mixedContentMode="always"
            allowUniversalAccessFromFileURLs
            onError={(syntheticEvent) => {
              log.error('[TerminalPage] WebView error:', syntheticEvent.nativeEvent.description);
              setError('WebView failed to load');
            }}
          />
          {!webViewReady && (
            <View
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: terminalBg,
              }}
            >
              <ActivityIndicator size="large" color={mutedColor} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, marginTop: 12 }}>
                Loading terminal...
              </Text>
            </View>
          )}
        </View>
      )}
      </PageContent>
    </View>
  );
}
