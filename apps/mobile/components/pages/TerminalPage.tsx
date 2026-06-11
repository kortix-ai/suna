/**
 * TerminalPage — Full terminal emulator for the mobile app.
 *
 * Uses the OpenCode PTY protocol (same as the frontend PtyTerminal):
 * 1. POST {sandboxUrl}/pty — create a new PTY session
 * 2. WebSocket at wss://{sandboxUrl}/pty/{ptyId}/connect?token={jwt} — raw data
 * 3. PATCH {sandboxUrl}/pty/{ptyId} — resize notifications
 * 4. DELETE {sandboxUrl}/pty/{ptyId} — cleanup on unmount
 *
 * The WebView uses a small local terminal surface. It intentionally avoids
 * third-party scripts because the WebSocket URL contains a short-lived bearer
 * token for browser-compatible PTY auth.
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
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
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
  const { wsUrl } = params;
  // Terminal is always dark, matching the web frontend
  const isDark = true;
  const bg = '#0f0f14';

  // Escape for safe JS string embedding
  const safeWsUrl = wsUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
      color: #e4e4e7;
      background: ${bg};
      font: 14px/1.25 Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-y: auto;
      outline: none;
    }
    #terminal::-webkit-scrollbar { width: 4px; }
    #terminal::-webkit-scrollbar-thumb {
      background: ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <div id="terminal" tabindex="0"></div>

  <script>
    (function() {
      var WS_URL = '${safeWsUrl}';

      var ws = null;
      var term = null;
      var resizeTimer = null;

      function postMsg(type, data) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, data: data }));
        } catch(e) {}
      }

      // ESCAPING CONTRACT: in TerminalPage.tsx this source lives inside a JS template
      // literal, so every backslash is written doubled (\\\\x1b, \\\\n, \\\\\\\\). The template
      // literal halves them; the WebView receives single-escaped JS. Never extract this
      // to a standalone .js file (or run it through another transform) without
      // un-doubling the backslashes. No backticks or dollar-brace interpolation
      // sequences may appear anywhere in this code (they would break the host
      // template literal).

      function sanitizeTerminalChunk(chunk) {
        // Strips the host-injected plain-text {"cursor":N,...} artifact. All
        // escape-sequence filtering lives in the parser (which, unlike per-chunk
        // regexes, handles sequences split across chunks via its pending buffer).
        // Tokens split across chunks are handled by the carry buffer in write().
        return String(chunk == null ? '' : chunk).replace(/\\{"cursor":\\d+[^{}]*\\}/g, '');
      }

      function createTerminal(el) {
        el = el || document.getElementById('terminal');

        var MAX_LINES = 1000;    // scrollback cap (rows)
        var MAX_COLS = 4000;     // hard per-row cell cap (memory DoS guard)
        var PENDING_MAX = 8192;  // cap for buffered incomplete escape sequences
        var CURSOR_TOKEN = '{"cursor":';

        // 16-color ANSI palette (dark theme). Index 0-7 normal, 8-15 bright.
        var PALETTE = [
          '#1a1a22', '#f87171', '#4ade80', '#fbbf24',
          '#60a5fa', '#c084fc', '#22d3ee', '#d4d4d8',
          '#52525b', '#fca5a5', '#86efac', '#fde68a',
          '#93c5fd', '#d8b4fe', '#67e8f9', '#fafafa'
        ];
        var DEFAULT_FG = '#e4e4e7';
        var DEFAULT_BG = '#0f0f14';

        // Rendering contract: the renderer needs pre whitespace + vertical scroll.
        // Enforce it here so the JS is self-contained (host CSS had pre-wrap).
        el.style.whiteSpace = 'pre';
        el.style.overflowY = 'auto';
        el.style.overflowX = 'auto';

        function defaultStyle() {
          return {
            fg: null, bg: null, fgIndex: -1,
            bold: false, dim: false, italic: false,
            underline: false, strike: false, inverse: false
          };
        }
        function cloneStyle(s) {
          return {
            fg: s.fg, bg: s.bg, fgIndex: s.fgIndex,
            bold: s.bold, dim: s.dim, italic: s.italic,
            underline: s.underline, strike: s.strike, inverse: s.inverse
          };
        }
        // Styles are copy-on-write (applySgr always clones), so blank cells can all
        // share one immutable style object.
        var BLANK_STYLE = defaultStyle();
        function blankCell() {
          return { ch: ' ', style: BLANK_STYLE };
        }

        // Screen model: array of rows; each row is an array of cells. Row arrays
        // carry a _dirty flag so render() only re-renders touched lines.
        var lines = [[]];
        var lineEls = [];        // one <div> per model line, kept in sync by render()
        var row = 0;
        var col = 0;
        var curStyle = defaultStyle();
        var pending = '';        // incomplete escape sequence carried across writes
        var sanitizeCarry = '';  // possible split {"cursor":N} tail carried across writes
        var carryTimer = null;
        var savedScreen = null;  // alt-screen (?1049/?47) saved state
        var renderQueued = false;

        // ----- real cell metrics (replaces the old hardcoded 8x18) -----
        function measureCell() {
          var probe = document.createElement('span');
          probe.style.position = 'absolute';
          probe.style.visibility = 'hidden';
          probe.style.whiteSpace = 'pre';
          probe.textContent = 'WWWWWWWWWW';
          el.appendChild(probe);
          var r = probe.getBoundingClientRect();
          el.removeChild(probe);
          return { w: (r.width / 10) || 8, h: r.height || 18 };
        }
        function size() {
          var rect = el.getBoundingClientRect();
          var padX = 0, padY = 0;
          try {
            var cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
            if (cs) {
              padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
              padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            }
          } catch (e) {}
          var cell = measureCell();
          return {
            cols: Math.max(20, Math.floor((rect.width - padX) / cell.w)),
            rows: Math.max(8, Math.floor((rect.height - padY) / cell.h))
          };
        }
        var currentSize = size();

        // First row of the visible viewport. Cursor addressing (CUP/VPA/CUU) and
        // erase ops are viewport-relative so full-redraw apps never touch scrollback.
        function viewTop() {
          var t = lines.length - currentSize.rows;
          return t > 0 ? t : 0;
        }

        function ensureRow(r) {
          while (lines.length <= r) lines.push([]);
        }
        function ensureCol(line, c) {
          if (c > MAX_COLS) c = MAX_COLS;
          while (line.length <= c) line.push(blankCell());
        }
        function trimScrollback() {
          var excess = lines.length - MAX_LINES;
          if (excess <= 0) return;
          lines.splice(0, excess);
          row -= excess;
          if (row < 0) row = 0;
          // Keep the per-line DOM nodes aligned with the model so dirty-row
          // rendering stays cheap (no full rebuild on trim).
          for (var i = 0; i < excess && lineEls.length > 0; i++) {
            var dead = lineEls.shift();
            if (dead.parentNode) dead.parentNode.removeChild(dead);
          }
        }

        // ----- 256-color -> approximate hex -----
        function color256(n) {
          n = n | 0;
          if (n < 0) n = 0;
          if (n < 16) return PALETTE[n];
          if (n >= 232) {
            var v = 8 + (n - 232) * 10;
            return rgbHex(v, v, v);
          }
          n -= 16;
          var r = Math.floor(n / 36);
          var g = Math.floor((n % 36) / 6);
          var b = n % 6;
          var conv = function(x) { return x === 0 ? 0 : 55 + x * 40; };
          return rgbHex(conv(r), conv(g), conv(b));
        }
        function rgbHex(r, g, b) {
          function h(x) {
            x = x | 0; // NaN/undefined -> 0, so a malformed param can never throw
            x = x < 0 ? 0 : (x > 255 ? 255 : x);
            var s = x.toString(16);
            return s.length < 2 ? '0' + s : s;
          }
          return '#' + h(r) + h(g) + h(b);
        }
        function hexToRgb(hex) {
          var v = parseInt(hex.slice(1), 16) | 0;
          return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
        }
        function mixHex(a, b, t) {
          var x = hexToRgb(a), y = hexToRgb(b);
          return rgbHex(
            Math.round(x[0] + (y[0] - x[0]) * t),
            Math.round(x[1] + (y[1] - x[1]) * t),
            Math.round(x[2] + (y[2] - x[2]) * t)
          );
        }

        // ----- SGR -----
        function applySgr(params) {
          if (params.length === 0) params = [0];
          // Fresh clone so cells already pointing at the previous curStyle object are
          // never mutated underneath us (copy-on-write per SGR change).
          var s = cloneStyle(curStyle);
          for (var i = 0; i < params.length; i++) {
            var p = params[i];
            if (isNaN(p)) p = 0;
            if (p === 0) { s = defaultStyle(); }
            else if (p === 1) { s.bold = true; }
            else if (p === 2) { s.dim = true; }
            else if (p === 3) { s.italic = true; }
            else if (p === 4) { s.underline = true; }
            else if (p === 9) { s.strike = true; }
            else if (p === 22) { s.bold = false; s.dim = false; }
            else if (p === 23) { s.italic = false; }
            else if (p === 24) { s.underline = false; }
            else if (p === 29) { s.strike = false; }
            else if (p === 7) { s.inverse = true; }
            else if (p === 27) { s.inverse = false; }
            else if (p === 39) { s.fg = null; s.fgIndex = -1; }
            else if (p === 49) { s.bg = null; }
            else if (p >= 30 && p <= 37) { s.fg = PALETTE[p - 30]; s.fgIndex = p - 30; }
            else if (p >= 90 && p <= 97) { s.fg = PALETTE[p - 90 + 8]; s.fgIndex = p - 90 + 8; }
            else if (p >= 40 && p <= 47) { s.bg = PALETTE[p - 40]; }
            else if (p >= 100 && p <= 107) { s.bg = PALETTE[p - 100 + 8]; }
            else if (p === 38 || p === 48) {
              // 38;5;n or 38;2;r;g;b — bounds-checked so a truncated sequence can
              // never read past params (previously threw via undefined.toString).
              var isFg = p === 38;
              var mode = params[i + 1];
              if (mode === 5 && i + 2 < params.length) {
                var idx = params[i + 2] | 0;
                var c5 = color256(idx);
                if (isFg) { s.fg = c5; s.fgIndex = (idx >= 0 && idx <= 15) ? idx : -1; }
                else { s.bg = c5; }
                i += 2;
              } else if (mode === 2 && i + 4 < params.length) {
                var ct = rgbHex(params[i + 2] | 0, params[i + 3] | 0, params[i + 4] | 0);
                if (isFg) { s.fg = ct; s.fgIndex = -1; }
                else { s.bg = ct; }
                i += 4;
              } else {
                i = params.length; // malformed extended color: stop, change nothing
              }
            }
            // other codes ignored (best-effort)
          }
          curStyle = s;
        }

        // ----- erase helpers (viewport-scoped; only ED 3 / RIS touch scrollback) -----
        function blankLine(r) {
          ensureRow(r);
          lines[r] = [];
          lines[r]._dirty = true;
        }
        function clearScreen() { // full reset including scrollback
          lines = [[]];
          lines[0]._dirty = true;
          row = 0;
          col = 0;
        }
        function eraseInDisplay(n) {
          ensureRow(row);
          var top = viewTop();
          if (n === 3) { clearScreen(); return; }          // ED 3: wipe scrollback too
          if (n === 2) {                                    // ED 2: clear visible screen only
            for (var r = top; r < lines.length; r++) blankLine(r);
            return;
          }
          if (n === 0) {                                    // cursor -> end of screen
            var line = lines[row];
            if (line.length > col) line.length = col;
            line._dirty = true;
            for (var r0 = row + 1; r0 < lines.length; r0++) blankLine(r0);
          } else if (n === 1) {                             // top of screen -> cursor
            for (var r1 = top; r1 < row; r1++) blankLine(r1);
            var ln = lines[row];
            var end = col > MAX_COLS ? MAX_COLS : col;
            ensureCol(ln, end);
            for (var c = 0; c <= end; c++) ln[c] = blankCell();
            ln._dirty = true;
          }
        }
        function eraseInLine(n) {
          ensureRow(row);
          var line = lines[row];
          if (n === 0) {
            if (line.length > col) line.length = col;
          } else if (n === 1) {
            var end = col > MAX_COLS ? MAX_COLS : col;
            ensureCol(line, end);
            for (var c = 0; c <= end; c++) line[c] = blankCell();
          } else if (n === 2) {
            lines[row] = [];
          }
          lines[row]._dirty = true;
        }

        // ----- cursor movement -----
        function moveTo(r, c) {
          if (r < 0) r = 0;
          var maxRow = lines.length + currentSize.rows; // sane growth bound (ESC[99999B etc.)
          if (r > maxRow) r = maxRow;
          if (c < 0) c = 0;
          if (c > MAX_COLS) c = MAX_COLS;
          row = r;
          col = c;
          ensureRow(row);
          trimScrollback();
        }

        function newline() {
          row += 1;
          ensureRow(row);
          trimScrollback();
        }

        function putChar(ch) {
          // Deferred autowrap at the reported width (matches what the PTY is told).
          if (col >= currentSize.cols || col >= MAX_COLS) { col = 0; newline(); }
          ensureRow(row);
          var line = lines[row];
          ensureCol(line, col);
          line[col] = { ch: ch, style: curStyle };
          line._dirty = true;
          col += 1;
        }

        // ----- params: "1;2;3" -> [1,2,3]; colon sub-params flattened for 38/48 -----
        function parseParams(s) {
          if (s === '') return [];
          var parts = s.split(';');
          var out = [];
          for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (part.indexOf(':') === -1) {
              out.push(part === '' ? 0 : parseInt(part, 10));
              continue;
            }
            var subs = part.split(':');
            if (subs[0] === '38' || subs[0] === '48') {
              // 38:2::r:g:b — drop the empty colorspace slot
              if (subs[1] === '2' && subs[2] === '') subs.splice(2, 1);
              for (var j = 0; j < subs.length; j++) {
                out.push(subs[j] === '' ? 0 : parseInt(subs[j], 10));
              }
            } else {
              // e.g. 4:3 (underline style) — keep only the base code so sub-params
              // are never misread as separate SGR codes
              out.push(subs[0] === '' ? 0 : parseInt(subs[0], 10));
            }
          }
          return out;
        }

        // Answer host queries (DSR/DA) over the outer ws when it exists, so programs
        // that block on a report don't stall. Replies are viewport-relative.
        function reply(s) {
          try {
            if (typeof ws !== 'undefined' && ws && ws.readyState === 1) ws.send(s);
          } catch (e) {}
        }

        // ----- main incremental parser -----
        // Mutates the screen model. Buffers an incomplete trailing escape (or a split
        // surrogate pair) into 'pending' so a half-parsed sequence is never shown.
        function parse(str) {
          var data = pending + str;
          pending = '';
          var i = 0;
          var len = data.length;

          while (i < len) {
            var code = data.charCodeAt(i);

            if (code === 0x1b) { // ESC
              if (len - i < 2) { pending = data.slice(i); return; } // need more
              var next = data.charAt(i + 1);

              if (next === '[') {
                // CSI: ESC [ params(0x30-0x3f) intermediates(0x20-0x2f) final(0x40-0x7e).
                // Anything else inside the body (a new ESC, C0, DEL) aborts the
                // sequence and we resume parsing from the offending byte.
                var j = i + 2;
                var fin = -1;
                var bad = -1;
                while (j < len) {
                  var cc = data.charCodeAt(j);
                  if (cc >= 0x40 && cc <= 0x7e) { fin = j; break; }
                  if (cc < 0x20 || cc > 0x3f) { bad = j; break; }
                  j++;
                }
                if (fin === -1 && bad === -1) { pending = data.slice(i); return; } // incomplete
                if (bad !== -1) { i = bad; continue; } // broken CSI: drop it, reparse
                handleCsi(data.slice(i + 2, fin), data.charAt(fin));
                i = fin + 1;
                continue;
              }

              if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
                // String sequences: OSC / DCS / SOS / PM / APC. Swallow the entire
                // payload; terminated by BEL or ST (ESC \\). A new ESC that is not ST,
                // or CAN/SUB, aborts the string (xterm behavior) so a stray
                // introducer can't mute the stream.
                var k = i + 2;
                var done = -1;
                var needMore = false;
                while (k < len) {
                  var oc = data.charCodeAt(k);
                  if (oc === 0x07) { done = k + 1; break; }              // BEL
                  if (oc === 0x18 || oc === 0x1a) { done = k + 1; break; } // CAN/SUB abort
                  if (oc === 0x1b) {
                    if (k + 1 >= len) { needMore = true; break; }        // ESC at very end
                    if (data.charAt(k + 1) === '\\\\') { done = k + 2; }   // ST
                    else { done = k; }                                   // abort, reparse at ESC
                    break;
                  }
                  k++;
                }
                if (done === -1 || needMore) { pending = data.slice(i); return; } // incomplete
                i = done; // swallowed entirely
                continue;
              }

              if (next === 'c') { // ESC c -> RIS full reset
                clearScreen();
                curStyle = defaultStyle();
                savedScreen = null;
                i += 2;
                continue;
              }

              // Other ESC sequences (ESC ( B, ESC =, ESC >, ESC M, ...): optional
              // intermediates 0x20-0x2f then one final byte. A new ESC or C0 in
              // final position aborts instead of being consumed.
              var ej = i + 1;
              while (ej < len && data.charCodeAt(ej) >= 0x20 && data.charCodeAt(ej) <= 0x2f) ej++;
              if (ej >= len) { pending = data.slice(i); return; }
              var fcc = data.charCodeAt(ej);
              if (fcc === 0x1b || fcc < 0x20) { i = ej; continue; } // broken: reparse from it
              i = ej + 1; // swallow whole ESC sequence
              continue;
            }

            // ----- control chars -----
            if (code === 0x0a) { newline(); i++; continue; }             // \\n (col preserved)
            if (code === 0x0d) { col = 0; i++; continue; }               // \\r
            if (code === 0x08) { if (col > 0) col -= 1; i++; continue; } // \\b
            if (code === 0x09) {                                          // \\t -> next 8-stop
              col = col - (col % 8) + 8;
              if (col > MAX_COLS) col = MAX_COLS;
              i++;
              continue;
            }
            if (code === 0x07) { i++; continue; }                        // BEL ignore
            if (code < 0x20) { i++; continue; }                          // drop other C0
            if (code === 0x7f) { i++; continue; }                        // drop DEL
            if (code >= 0x80 && code <= 0x9f) { i++; continue; }         // drop raw C1

            // printable — keep surrogate pairs in one cell so emoji never split
            var ch = data.charAt(i);
            if (code >= 0xd800 && code <= 0xdbff) {
              if (i + 1 >= len) { pending = data.slice(i); return; }     // pair split across chunks
              var lo = data.charCodeAt(i + 1);
              if (lo >= 0xdc00 && lo <= 0xdfff) { ch += data.charAt(i + 1); i++; }
            }
            putChar(ch);
            i++;
          }
        }

        function handleCsi(body, finalByte) {
          var first = body.charAt(0);
          var isPrivate = first === '?' || first === '>' || first === '=' || first === '<';
          if (isPrivate) body = body.slice(1);
          // remove intermediate bytes (0x20-0x2f) from the tail for param parse
          var paramStr = body.replace(/[ -\\/]+$/, '');
          var params = parseParams(paramStr);
          var n = params.length ? params[0] : 0;

          if (isPrivate) {
            // Private sequences must NEVER hit the standard handlers (ESC[>4;2m used
            // to run applySgr and permanently enable dim). Handle the useful ones,
            // swallow the rest.
            if (first === '?' && (finalByte === 'h' || finalByte === 'l')) {
              for (var pi = 0; pi < params.length; pi++) {
                var pm = params[pi];
                if (pm === 1049 || pm === 1047 || pm === 47) {
                  if (finalByte === 'h' && !savedScreen) {
                    // alt screen: save main buffer, start fresh
                    savedScreen = { lines: lines, row: row, col: col, style: curStyle };
                    lines = [[]];
                    lines[0]._dirty = true;
                    row = 0;
                    col = 0;
                    curStyle = defaultStyle();
                  } else if (finalByte === 'l' && savedScreen) {
                    lines = savedScreen.lines;
                    row = savedScreen.row;
                    col = savedScreen.col;
                    curStyle = savedScreen.style;
                    savedScreen = null;
                    for (var ri = 0; ri < lines.length; ri++) lines[ri]._dirty = true;
                  }
                }
              }
            } else if (first === '?' && finalByte === 'J') {
              eraseInDisplay(params.length ? n : 0); // DECSED ~ ED
            } else if (first === '>' && finalByte === 'c') {
              reply('\\x1b[>0;0;0c'); // secondary DA
            }
            return;
          }

          switch (finalByte) {
            case 'm':
              applySgr(params);
              break;
            case 'J':
              eraseInDisplay(params.length ? n : 0);
              break;
            case 'K':
              eraseInLine(params.length ? n : 0);
              break;
            case 'H':
            case 'f': {
              // CUP is viewport-relative and clamped to the screen, so a redraw can
              // never overwrite scrollback.
              var r = (params.length >= 1 ? params[0] : 1) - 1;
              var c = (params.length >= 2 ? params[1] : 1) - 1;
              if (r < 0) r = 0;
              if (r > currentSize.rows - 1) r = currentSize.rows - 1;
              if (c < 0) c = 0;
              if (c > currentSize.cols - 1) c = currentSize.cols - 1;
              moveTo(viewTop() + r, c);
              break;
            }
            case 'A': { // up, clamped at top of viewport
              var tA = viewTop();
              var rA = row - (n || 1);
              moveTo(rA < tA ? tA : rA, col);
              break;
            }
            case 'B': { // down, clamped at bottom of viewport
              var bB = viewTop() + currentSize.rows - 1;
              var rB = row + (n || 1);
              moveTo(rB > bB ? bB : rB, col);
              break;
            }
            case 'C': { // forward
              var cC = col + (n || 1);
              if (cC > currentSize.cols - 1) cC = currentSize.cols - 1;
              moveTo(row, cC);
              break;
            }
            case 'D': moveTo(row, col - (n || 1)); break; // back (clamps at 0)
            case 'd': { // line position absolute (viewport-relative)
              var rd = (n || 1) - 1;
              if (rd > currentSize.rows - 1) rd = currentSize.rows - 1;
              moveTo(viewTop() + rd, col);
              break;
            }
            case 'G': { // column position absolute
              var cG = (n || 1) - 1;
              if (cG > currentSize.cols - 1) cG = currentSize.cols - 1;
              moveTo(row, cG);
              break;
            }
            case '@': { // ICH: insert n blanks at cursor
              ensureRow(row);
              var lI = lines[row];
              if (col < lI.length) {
                var cntI = n || 1;
                if (cntI > MAX_COLS) cntI = MAX_COLS;
                for (var xI = 0; xI < cntI; xI++) lI.splice(col, 0, blankCell());
                if (lI.length > MAX_COLS) lI.length = MAX_COLS;
                lI._dirty = true;
              }
              break;
            }
            case 'P': { // DCH: delete n chars at cursor
              ensureRow(row);
              var lP = lines[row];
              if (col < lP.length) {
                lP.splice(col, n || 1);
                lP._dirty = true;
              }
              break;
            }
            case 'X': { // ECH: blank n chars from cursor
              ensureRow(row);
              var lX = lines[row];
              var cntX = n || 1;
              if (cntX > MAX_COLS) cntX = MAX_COLS;
              ensureCol(lX, col + cntX - 1);
              for (var xX = 0; xX < cntX; xX++) lX[col + xX] = blankCell();
              lX._dirty = true;
              break;
            }
            case 'n': // DSR: report cursor position (viewport-relative)
              if (n === 6) reply('\\x1b[' + (row - viewTop() + 1) + ';' + (col + 1) + 'R');
              else if (n === 5) reply('\\x1b[0n');
              break;
            case 'c': // DA1
              reply('\\x1b[?6c');
              break;
            // everything else (S,T,L,M,r,h,l,t, ...) -> swallow silently
            default:
              break;
          }
        }

        // ----- HTML escape (XSS-safe in element AND attribute positions) -----
        function esc(s) {
          return s.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;');
        }

        function styleToCss(s) {
          var fg = s.fg, bg = s.bg;
          // bold-is-bright: bold + dark palette colors promote to the bright row so
          // bold-black is never invisible on the dark background
          if (s.bold && s.fgIndex >= 0 && s.fgIndex <= 7) fg = PALETTE[s.fgIndex + 8];
          if (s.inverse) {
            var tf = fg == null ? DEFAULT_FG : fg;
            var tb = bg == null ? DEFAULT_BG : bg;
            fg = tb;
            bg = tf;
          }
          // dim: fade only the foreground toward the background (opacity also faded
          // the cell background, which real terminals don't do)
          if (s.dim) fg = mixHex(fg == null ? DEFAULT_FG : fg, DEFAULT_BG, 0.5);
          var css = '';
          if (fg != null) css += 'color:' + fg + ';';
          if (bg != null) css += 'background:' + bg + ';';
          if (s.bold) css += 'font-weight:700;';
          if (s.italic) css += 'font-style:italic;';
          var deco = '';
          if (s.underline) deco = 'underline';
          if (s.strike) deco += (deco === '' ? '' : ' ') + 'line-through';
          if (deco !== '') css += 'text-decoration:' + deco + ';';
          return css;
        }

        function emitRun(text, style) {
          var css = styleToCss(style);
          if (css === '') return esc(text);
          return '<span style="' + css + '">' + esc(text) + '</span>';
        }

        function lineToHtml(line) {
          var html = '';
          var runText = '';
          var runStyle = null;
          for (var c = 0; c < line.length; c++) {
            var cell = line[c];
            // identity compare: styles are shared immutable objects, so runs
            // naturally share the same reference (no per-cell key strings)
            if (runStyle === null) { runStyle = cell.style; runText = cell.ch; }
            else if (cell.style === runStyle) { runText += cell.ch; }
            else {
              html += emitRun(runText, runStyle);
              runStyle = cell.style;
              runText = cell.ch;
            }
          }
          if (runStyle !== null) html += emitRun(runText, runStyle);
          return html;
        }

        // ----- render: one <div> per line, only dirty lines re-rendered -----
        function render() {
          renderQueued = false;
          var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
          while (lineEls.length > lines.length) {
            var gone = lineEls.pop();
            if (gone.parentNode) gone.parentNode.removeChild(gone);
          }
          while (lineEls.length < lines.length) {
            var div = document.createElement('div');
            el.appendChild(div);
            lineEls.push(div);
          }
          for (var r = 0; r < lines.length; r++) {
            var line = lines[r];
            var node = lineEls[r];
            if (node._line === line && !line._dirty) continue;
            var html = lineToHtml(line);
            node.innerHTML = html === '' ? '<br>' : html;
            node._line = line;
            line._dirty = false;
          }
          // only auto-scroll when the user was already at the bottom
          if (atBottom) el.scrollTop = el.scrollHeight;
        }

        function scheduleRender() {
          if (renderQueued) return;
          renderQueued = true;
          if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(render);
          } else {
            setTimeout(render, 0);
          }
        }

        // parse() wrapped so one hostile/malformed sequence can never drop the rest
        // of a chunk, and 'pending' is capped so a stray unterminated introducer can
        // never mute the terminal forever or grow memory without bound.
        function safeParse(str) {
          try {
            parse(str);
          } catch (e) {
            pending = '';
          }
          var guard = 0;
          while (pending.length > PENDING_MAX && guard++ < 64) {
            var spill = pending.slice(2); // drop the stuck 2-byte introducer
            pending = '';
            try { parse(spill); } catch (e2) { pending = ''; break; }
          }
        }

        // Length of a chunk tail that could be the start of a split {"cursor":N}
        // token (held back until the next chunk or a short timeout).
        function cursorTailLen(s) {
          var idx = s.lastIndexOf('{');
          if (idx === -1) return 0;
          var tail = s.slice(idx);
          if (tail.length > 32) return 0;                 // too long to be the token
          if (tail.indexOf('}') !== -1) return 0;         // complete tokens already stripped
          if (tail.length <= CURSOR_TOKEN.length) {
            return CURSOR_TOKEN.slice(0, tail.length) === tail ? tail.length : 0;
          }
          if (tail.slice(0, CURSOR_TOKEN.length) !== CURSOR_TOKEN) return 0;
          return /^\\d[^{}]*$/.test(tail.slice(CURSOR_TOKEN.length)) ? tail.length : 0;
        }

        function flushCarry() {
          carryTimer = null;
          if (sanitizeCarry === '') return;
          var spill = sanitizeCarry;
          sanitizeCarry = '';
          safeParse(spill); // never completed into a token: show it as-is
          scheduleRender();
        }

        // ----- public write -----
        function write(value) {
          if (carryTimer !== null) { clearTimeout(carryTimer); carryTimer = null; }
          var raw = sanitizeCarry + String(value == null ? '' : value);
          sanitizeCarry = '';
          var clean = sanitizeTerminalChunk(raw);
          var hold = cursorTailLen(clean);
          if (hold > 0) {
            sanitizeCarry = clean.slice(clean.length - hold);
            clean = clean.slice(0, clean.length - hold);
            carryTimer = setTimeout(flushCarry, 80);
          }
          safeParse(clean);
          scheduleRender();
        }

        el.addEventListener('keydown', function(event) {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          var data = null;
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) data = event.key;
          else if (event.key === 'Enter') data = '\\r';
          else if (event.key === 'Backspace') data = '\\x7f';
          else if (event.key === 'Tab') data = '\\t';
          else if (event.key === 'ArrowUp') data = '\\x1b[A';
          else if (event.key === 'ArrowDown') data = '\\x1b[B';
          else if (event.key === 'ArrowRight') data = '\\x1b[C';
          else if (event.key === 'ArrowLeft') data = '\\x1b[D';
          if (data !== null) {
            event.preventDefault();
            ws.send(data);
          }
        });
        el.focus();

        return {
          get cols() { return currentSize.cols; },
          get rows() { return currentSize.rows; },
          write: write,
          writeln: function(value) { write(String(value == null ? '' : value) + '\\r\\n'); },
          clear: function() {
            clearScreen();
            curStyle = defaultStyle();
            pending = '';
            sanitizeCarry = '';
            if (carryTimer !== null) { clearTimeout(carryTimer); carryTimer = null; }
            savedScreen = null;
            render();
          },
          fit: function() { currentSize = size(); }
        };
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
          // Generic message only — e.message can echo the WS URL, which
          // carries the short-lived bearer token in its query string.
          if (term) term.writeln('\\x1b[31mFailed to create WebSocket connection\\x1b[0m');
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
          term = createTerminal();

          // Refit on viewport changes
          var fitTimer = null;
          function debouncedFit() {
            clearTimeout(fitTimer);
            fitTimer = setTimeout(function() {
              try {
                term.fit();
                postMsg('resize', { cols: term.cols, rows: term.rows });
              } catch(e) {}
            }, 100);
          }
          window.addEventListener('resize', debouncedFit);
          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(debouncedFit).observe(document.getElementById('terminal'));
          }

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
            if (term) {
              setTimeout(function() { try { term.fit(); } catch(e) {} }, 50);
            }
          }
        } catch(e) {}
      }
      window.addEventListener('message', handleRNMessage);
      document.addEventListener('message', handleRNMessage);

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTerminal);
      } else {
        initTerminal();
      }
    })();
  <\/script>
</body>
</html>`;
}

// ─── TerminalPage ────────────────────────────────────────────────────────────

export function TerminalPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: TerminalPageProps) {
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
        log.log('[TerminalPage] WS URL prepared:', { ptyId: pty.id });

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
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
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
