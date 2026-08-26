/**
 * Cold time-to-first-token for the worker, measured INSIDE the box.
 * Symmetric with measure/opencode.js: same clock, same definition of "first".
 *
 * `first` counts ONLY a text_delta. Agent events carry the accumulating
 * message, so a looser check matches the USER's own text part and reports a
 * first token ~35 ms after ready — before any model call could have returned.
 */
const http = require('node:http');

const t0 = process.hrtime.bigint();
const el = () => Number(process.hrtime.bigint() - t0) / 1e6;
const PROMPT = process.env.KX_PROMPT || 'Say the single word: ready';

const get = (path) =>
  new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: 8080, path, method: 'GET' }, (x) => {
      let d = '';
      x.on('data', (c) => (d += c));
      x.on('end', () => res(d));
    });
    r.on('error', () => res(''));
    r.end();
  });

(async () => {
  let ready = null;
  for (let i = 0; i < 3000; i++) {
    if (await get('/health')) { ready = el(); break; }
    await new Promise((r) => setTimeout(r, 20));
  }

  const payload = JSON.stringify({ text: PROMPT });
  let first = null;
  await new Promise((done) => {
    const r = http.request(
      { host: '127.0.0.1', port: 8080, path: '/turn', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (first === null && chunk.includes('"type":"text_delta"')) { first = el(); done(); }
        });
        res.on('end', () => done());
      },
    );
    r.on('error', () => done());
    r.end(payload);
  });

  console.log('MEASURE=' + JSON.stringify({ ready, first }));
  process.exit(0);
})();
