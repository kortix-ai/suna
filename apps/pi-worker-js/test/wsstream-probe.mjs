// The client half of test/streaming.sh: connect, print every event, exit.
//
// Prints rather than asserts, so the shell script owns the judgement and a
// failure shows the whole stream instead of a boolean.
const [, , port, session] = process.argv;
const ws = new WebSocket(`ws://127.0.0.1:${port}/?c=${session}`);
const seen = [];
ws.onopen = () => console.log("connected");
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  seen.push(m.type);
  const extra = m.tool ? ` tool=${m.tool}` : m.output ? ` out=${m.output.slice(0, 60)}` : m.turn ? ` turn=${m.turn}` : "";
  console.log(`${m.type}${extra}`);
};
ws.onclose = (e) => console.log(`closed code=${e.code}`);
setTimeout(() => { console.log(`total=${seen.length}`); process.exit(0); }, 14000);
