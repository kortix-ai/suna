// Multi-socket probe for test/streaming.sh's deeper claims.
//
// Opens N watchers across one or two sessions, records every event with its
// arrival order and which socket saw it, and prints one JSON line. The shell
// script does the judging, so a failure shows the whole picture rather than a
// boolean.
//
// Usage: node test/wsdeep-probe.mjs <port> <sessionA> <sessionB> <watchersPerSession> <runMs>
const [, , port, sessionA, sessionB, perSession, runMs] = process.argv;
const N = Number(perSession);
const sockets = [];
const log = [];

function open(session, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?c=${session}`);
  const rec = { label, session, events: [], closed: null, opened: false };
  ws.onopen = () => { rec.opened = true; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    rec.events.push(m.type);
    log.push({ label, session, type: m.type, tool: m.tool ?? null, turn: m.turn ?? null, at: Date.now() });
  };
  ws.onclose = (e) => { rec.closed = e.code; };
  ws.onerror = () => {};
  sockets.push({ ws, rec });
  return rec;
}

const recs = [];
for (let i = 0; i < N; i++) recs.push(open(sessionA, `A${i}`));
for (let i = 0; i < N; i++) recs.push(open(sessionB, `B${i}`));

// A late watcher, opened halfway, to check what `hello` reports mid-flight.
setTimeout(() => recs.push(open(sessionA, "A-late")), Math.floor(Number(runMs) / 3));

// A watcher that connects and immediately drops, then reconnects — the shape a
// browser tab produces on refresh.
setTimeout(() => {
  const r = open(sessionA, "A-flap");
  setTimeout(() => { try { sockets.find((s) => s.rec === r).ws.close(); } catch {} }, 300);
  setTimeout(() => recs.push(open(sessionA, "A-reconnect")), 900);
}, Math.floor(Number(runMs) / 4));

// Ask for status over the socket, which is the only thing the protocol accepts.
setTimeout(() => {
  const s = sockets[0];
  try { s.ws.send(JSON.stringify({ type: "status" })); } catch {}
}, Math.floor(Number(runMs) / 2));

setTimeout(() => {
  console.log(JSON.stringify({
    watchers: recs.map((r) => ({ label: r.label, session: r.session, events: r.events, closed: r.closed, opened: r.opened })),
    order: log.map((l) => `${l.label}:${l.type}`),
  }));
  process.exit(0);
}, Number(runMs));
