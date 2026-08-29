/**
 * Cold time-to-first-token for today's architecture, measured INSIDE the box.
 *
 * Reads KX_PROMPT and KX_MODEL from the environment. Prints one line:
 *   MEASURE={"ready":<ms>,"first":<ms>}
 *
 * `ready`  runtimeReady:true on kortixd's /kortix/health — the point the box
 *          can serve a prompt at all.
 * `first`  the first token OF THE ASSISTANT'S ANSWER.
 *
 * The naive "first event containing text" detector is wrong here: opencode
 * echoes the USER message back over the same stream the instant the prompt is
 * accepted (verified live — user text at 1975 ms, assistant announced at
 * 2013 ms, its first real token later still). So this latches the assistant
 * message id from `message.updated` and only counts parts belonging to it.
 */
const http = require('node:http');

const t0 = process.hrtime.bigint();
const el = () => Number(process.hrtime.bigint() - t0) / 1e6;
const PROMPT = process.env.KX_PROMPT || 'Say the single word: ready';
const MODEL = process.env.KX_MODEL || 'anthropic/claude-sonnet-4.5';

const req = (opts, body) =>
  new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', ...opts }, (x) => {
      let d = '';
      x.setEncoding('utf8');
      x.on('data', (c) => (d += c));
      x.on('end', () => res(d));
    });
    r.on('error', () => res(''));
    if (body) r.write(body);
    r.end();
  });

(async () => {
  let ready = null;
  for (let i = 0; i < 6000; i++) {
    const h = await req({ port: 8000, path: '/kortix/health', method: 'GET' });
    if (h.includes('"runtimeReady":true')) { ready = el(); break; }
    await new Promise((r) => setTimeout(r, 20));
  }

  let assistantId = null;
  let first = null;
  let done;
  const finished = new Promise((r) => (done = r));

  // Subscribe BEFORE prompting so the first token cannot be missed.
  const ev = http.request({ host: '127.0.0.1', port: 4096, path: '/event', method: 'GET' }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let j;
        try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.type === 'message.updated' && j.properties && j.properties.info && j.properties.info.role === 'assistant') {
          assistantId = j.properties.info.id;
        }
        if (first === null && assistantId && j.type === 'message.part.updated') {
          const p = j.properties && j.properties.part;
          if (p && p.messageID === assistantId && p.type === 'text' && String(p.text || '').length > 0) {
            first = el();
            done();
          }
        }
      }
    });
  });
  ev.on('error', () => {});
  ev.end();
  await new Promise((r) => setTimeout(r, 200));

  const s = await req({ port: 4096, path: '/session', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 } }, '{}');
  let sid;
  try { sid = JSON.parse(s).id; } catch {
    console.log('MEASURE=' + JSON.stringify({ ready, first: null, err: 'no session: ' + s.slice(0, 120) }));
    process.exit(0);
  }
  const body = JSON.stringify({ model: { providerID: 'openrouter', modelID: MODEL }, parts: [{ type: 'text', text: PROMPT }] });
  req({ port: 4096, path: '/session/' + sid + '/message', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, body);

  const timeout = setTimeout(() => done(), 240000);
  await finished;
  clearTimeout(timeout);
  try { ev.destroy(); } catch {}
  console.log('MEASURE=' + JSON.stringify({ ready, first }));
  process.exit(0);
})();
