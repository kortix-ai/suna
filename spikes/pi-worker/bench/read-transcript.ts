/**
 * Read a session transcript with NOTHING running.
 *
 * This file imports no pi package, constructs no harness, and starts no
 * sandbox. It reads the append-only log and renders the conversation. That is
 * the whole point of S0.4 and the preview of P1.8: today, fetching messages
 * means waking a box, waiting for the daemon, waiting for OpenCode to listen,
 * then calling an API designed for a local editor.
 *
 *   bun bench/read-transcript.ts <storeUrl> <sessionId>
 *   bun bench/read-transcript.ts http://127.0.0.1:8200 sess-demo --json
 */
const [storeUrl, sessionId, ...rest] = process.argv.slice(2);
if (!storeUrl || !sessionId) {
  console.error('usage: bun bench/read-transcript.ts <storeUrl> <sessionId> [--json]');
  process.exit(2);
}
const asJson = rest.includes('--json');

const t0 = performance.now();
const res = await fetch(`${storeUrl}/sessions/${encodeURIComponent(sessionId)}/log`);
if (!res.ok) { console.error(`store returned HTTP ${res.status}`); process.exit(1); }
const log = (await res.json()) as any[];
const readMs = performance.now() - t0;

const messages = log
  .filter((i) => i.kind === 'entry' && i.entry?.type === 'message')
  .map((i) => ({ at: i.entry.timestamp, seq: i.entry.seq, id: i.entry.id, ...i.entry.message }));

if (asJson) {
  console.log(JSON.stringify({ sessionId, readMs, messages }, null, 2));
} else {
  console.log(`\nsession ${sessionId}   ${messages.length} messages   read in ${readMs.toFixed(0)} ms   (no worker, no sandbox)\n`);
  for (const m of messages) {
    const when = new Date(m.at).toISOString().slice(11, 19);
    for (const c of m.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) {
        console.log(`  ${when}  ${String(m.role).padEnd(10)} ${c.text.trim().replace(/\n/g, '\n' + ' '.repeat(22))}`);
      } else if (c.type === 'toolCall') {
        console.log(`  ${when}  ${'tool call'.padEnd(10)} ${c.name}(${JSON.stringify(c.arguments).slice(0, 90)})`);
      } else if (c.type === 'thinking') {
        console.log(`  ${when}  ${'thinking'.padEnd(10)} ${String(c.thinking).slice(0, 90)}`);
      }
    }
    if (m.role === 'toolResult' && !(m.content ?? []).some((c: any) => c.type === 'text')) {
      console.log(`  ${when}  ${'result'.padEnd(10)} (${m.toolName})`);
    }
  }
  console.log('');
}
