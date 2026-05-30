#!/usr/bin/env bun
// e2e smoke for the preview WebSocket PTY proxy.
//
// Connects to the SAME URL the browser xterm uses
//   ws://localhost:8008/v1/p/{sandbox}/8000/pty/{ptyId}/connect?token=...
// drives a command, and asserts the shell's output comes back through the
// API → Daytona(4096) → opencode pipe.
//
// Usage:
//   bun tests/e2e/scripts/pty-ws-smoke.ts <sandboxId> <jwt> [ptyId]
// If ptyId is omitted, the first running PTY from GET /pty is used.

const API = process.env.API_BASE || 'http://localhost:8008/v1';
const sandboxId = process.argv[2];
const token = process.argv[3];
let ptyId = process.argv[4];

if (!sandboxId || !token) {
  console.error('usage: bun pty-ws-smoke.ts <sandboxId> <jwt> [ptyId]');
  process.exit(2);
}

const http = `${API}/p/${sandboxId}/8000`;
const auth = { Authorization: `Bearer ${token}` };

async function ensurePty(): Promise<string> {
  if (ptyId) return ptyId;
  const res = await fetch(`${http}/pty`, { headers: auth });
  if (!res.ok) throw new Error(`GET /pty -> ${res.status}: ${await res.text()}`);
  const list = (await res.json()) as Array<{ id: string; status: string }>;
  const running = list.find((p) => p.status === 'running') || list[0];
  if (running) return running.id;
  // none — create one
  const create = await fetch(`${http}/pty`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } }),
  });
  if (!create.ok) throw new Error(`POST /pty -> ${create.status}: ${await create.text()}`);
  return ((await create.json()) as { id: string }).id;
}

async function main() {
  ptyId = await ensurePty();
  const wsUrl = `${API.replace(/^http/, 'ws')}/p/${sandboxId}/8000/pty/${ptyId}/connect?token=${encodeURIComponent(token)}`;
  console.log(`[smoke] pty=${ptyId}`);
  console.log(`[smoke] connecting ${wsUrl.replace(token, token.slice(0, 12) + '…')}`);

  const marker = `PTY_OK_${Math.floor(Date.now() / 1000)}`;
  let received = '';
  let opened = false;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  const done = new Promise<{ ok: boolean; reason: string }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: received.includes(marker), reason: opened ? 'timeout-no-marker' : 'timeout-never-opened' });
    }, 12000);

    ws.onopen = () => {
      opened = true;
      console.log('[smoke] OPEN');
      // Give the shell a beat, then echo a unique marker.
      setTimeout(() => ws.send(`echo ${marker}\n`), 400);
    };
    ws.onmessage = (ev) => {
      const text = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : String(ev.data);
      received += text;
      if (received.includes(marker) && received.split(marker).length > 2) {
        // marker appears twice: once as the echoed input line, once as output
        clearTimeout(timer);
        resolve({ ok: true, reason: 'marker-echoed' });
      }
    };
    ws.onerror = (e: any) => {
      console.log('[smoke] ERROR', e?.message || e);
    };
    ws.onclose = (ev) => {
      console.log(`[smoke] CLOSE code=${ev.code} reason=${ev.reason}`);
      if (!received.includes(marker)) {
        clearTimeout(timer);
        resolve({ ok: false, reason: `closed-${ev.code}` });
      }
    };
  });

  const result = await done;
  try { ws.close(); } catch {}
  console.log('[smoke] received bytes:', received.length);
  if (received.length) console.log('[smoke] tail:', JSON.stringify(received.slice(-200)));
  if (result.ok) {
    console.log(`✅ PASS (${result.reason})`);
    process.exit(0);
  } else {
    console.log(`❌ FAIL (${result.reason})`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌ FAIL', e);
  process.exit(1);
});
