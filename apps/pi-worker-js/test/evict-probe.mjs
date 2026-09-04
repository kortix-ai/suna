// Hold a WebSocket across a cell eviction and report what it saw — including
// whether the socket is still USABLE, not merely still open.
//
// The distinction is the whole point. celld 0.3.0 does not hand a hibernated
// socket back to a rebuilt cell, so the client keeps a socket that looks alive,
// will never receive another event, and gets no close event to trigger
// reconnect logic. A liveness PROBE is the only way a client can tell.
//
// Usage: node test/evict-probe.mjs <port> <session> <holdMs> [probeAtMs]
const [, , port, session, holdMs, probeAt] = process.argv;
const ws = new WebSocket(`ws://127.0.0.1:${port}/?c=${session}`);
const rec = { opened: false, events: [], closed: false, closeCode: null, error: null, probeAnswered: null };
ws.onopen = () => { rec.opened = true; };
ws.onmessage = (e) => {
  let m = {}; try { m = JSON.parse(e.data); } catch { /* ignore */ }
  rec.events.push(m.type ?? "?");
  if (m.type === "status" && rec.probeAnswered === false) rec.probeAnswered = true;
};
ws.onclose = (e) => { rec.closed = true; rec.closeCode = e.code; };
ws.onerror = () => { rec.error = "socket error"; };

if (probeAt) {
  setTimeout(() => {
    rec.probeAnswered = false;
    try { ws.send(JSON.stringify({ type: "status" })); } catch { rec.error = "send failed"; }
  }, Number(probeAt));
}
await new Promise((r) => setTimeout(r, Number(holdMs)));
console.log(JSON.stringify(rec));
try { ws.close(); } catch { /* already gone */ }
process.exit(0);
