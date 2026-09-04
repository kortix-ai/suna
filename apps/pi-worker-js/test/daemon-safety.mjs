// THE DAEMON IS THE SECURITY BOUNDARY, so test it like one.
//
// It runs arbitrary shell commands and reads and writes arbitrary paths on
// behalf of a cell. Its own header says paths are "resolved, then required to
// still be under the session directory" and admits "a symlink could still
// defeat this". That admission was never tested, which is the same as not
// knowing whether it is true.
//
// Runs in-process against the real createDaemon(). No Docker, no cell, no
// bucket — this is HTTP and a filesystem, and both are here.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=24

import { mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "test-token";
process.env.WORK_ROOT = "/tmp/daemon-safety-work";
const PORT = 7123;
const { createDaemon } = await import("../daemon/server.js");

await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await mkdir(process.env.WORK_ROOT, { recursive: true });

const server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

const call = async (path, body, token = "test-token") => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ── the token ───────────────────────────────────────────────────────────────
const noAuth = await call("/exec", { opId: "a1", sessionId: "s", command: "echo hi" }, "wrong");
check("a wrong token is refused", noAuth.status === 401, JSON.stringify(noAuth));

// ── opId is mandatory, because it is what makes a retry safe ────────────────
const noOp = await call("/exec", { sessionId: "s", command: "echo hi" });
check("a call with no opId is refused", noOp.status === 400, JSON.stringify(noOp.body).slice(0, 90));

// ── path confinement ────────────────────────────────────────────────────────
const escapes = [
  ["../../etc/passwd", "a relative escape"],
  ["/etc/passwd", "an absolute path"],
  ["a/../../../../etc/passwd", "an escape hidden mid-path"],
];
for (const [p, label] of escapes) {
  const r = await call("/read", { opId: `esc_${p}`, sessionId: "s", path: p });
  const leaked = typeof r.body.content === "string" && r.body.content.includes("root:");
  check(`read refuses ${label}`, !leaked, `content=${String(r.body.content).slice(0, 60)}`);
}

// ── THE SYMLINK, which the daemon's own comment admits it may not stop ───────
await mkdir(join(process.env.WORK_ROOT, "s"), { recursive: true });
await symlink("/etc", join(process.env.WORK_ROOT, "s", "escape")).catch(() => {});
const viaLink = await call("/read", { opId: "sym1", sessionId: "s", path: "escape/hosts" });
check("read does not follow a symlink out of the session directory",
  !(typeof viaLink.body.content === "string" && viaLink.body.content.length > 0),
  `symlink read returned ${String(viaLink.body.content).slice(0, 60)}`);

const writeVia = await call("/write", { opId: "sym2", sessionId: "s", path: "escape/pwned.txt", content: "x" });
let wrote = false;
try { await readFile("/etc/pwned.txt", "utf8"); wrote = true; } catch { /* good */ }
check("write does not follow a symlink out of the session directory", !wrote,
  `write said ${JSON.stringify(writeVia.body).slice(0, 80)}`);

// ── session isolation ───────────────────────────────────────────────────────
await call("/write", { opId: "iso1", sessionId: "alice", path: "secret.txt", content: "alice-only" });
const cross = await call("/read", { opId: "iso2", sessionId: "bob", path: "../alice/secret.txt" });
check("one session cannot read another's files",
  !(typeof cross.body.content === "string" && cross.body.content.includes("alice-only")),
  String(cross.body.content).slice(0, 60));

// ── idempotency and single flight ───────────────────────────────────────────
const marker = join(process.env.WORK_ROOT, "s", "count.txt");
await writeFile(marker, "");
const cmd = "echo x >> count.txt";
const first = await call("/exec", { opId: "idem1", sessionId: "s", command: cmd });
const again = await call("/exec", { opId: "idem1", sessionId: "s", command: cmd });
const lines = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean).length;
check("a replayed opId does not run the command twice", lines === 1, `${lines} executions`);
check("the replay is marked", again.body.replayed === true, JSON.stringify(again.body).slice(0, 80));

// Concurrent retries of an in-flight op must JOIN, not race.
const slow = "sleep 1; echo y >> count.txt";
const [r1, r2, r3] = await Promise.all([
  call("/exec", { opId: "flight1", sessionId: "s", command: slow }),
  call("/exec", { opId: "flight1", sessionId: "s", command: slow }),
  call("/exec", { opId: "flight1", sessionId: "s", command: slow }),
]);
const ys = (await readFile(marker, "utf8")).split("\n").filter((l) => l === "y").length;
check("three concurrent retries execute once", ys === 1, `${ys} executions`);
check("the joiners are told they joined",
  [r1, r2, r3].filter((r) => r.body.joined || r.body.replayed).length === 2,
  JSON.stringify([r1.body, r2.body, r3.body]).slice(0, 120));

// ── a failure must not wedge the id forever ─────────────────────────────────
const boom = await call("/nope", { opId: "bad1", sessionId: "s" });
check("an unknown route is a 404, not a hang", boom.status === 404, JSON.stringify(boom.body));

// ── output is bounded ───────────────────────────────────────────────────────
const big = await call("/exec", { opId: "big1", sessionId: "s", command: "head -c 200000 /dev/zero | tr '\\0' 'a'" });
check("stdout is truncated rather than unbounded",
  (big.body.stdout ?? "").length <= 50_000,
  `${(big.body.stdout ?? "").length} bytes`);

// ── timeout ─────────────────────────────────────────────────────────────────
const timed = await call("/exec", { opId: "to1", sessionId: "s", command: "sleep 5", timeout: 1 });
check("a command past its timeout is killed", timed.body.killed === true && timed.body.exitCode === 124,
  JSON.stringify(timed.body).slice(0, 90));

// ── a body the daemon will not swallow ──────────────────────────────────────
// The request body is accumulated into a string. Without a cap, one caller can
// make this process allocate until it dies, and the caller is a cell running
// model-authored commands. The cap had never been exercised: 8 MB is more than
// any real edit and less than a memory problem, which is exactly why nothing
// tested it.
{
  const raw = async (body, ms = 15_000) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/write`, {
        method: "POST", signal: ctl.signal,
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body,
      });
      return { status: res.status };
    } catch (e) { return { status: "refused", err: String(e?.name ?? e) }; }
    finally { clearTimeout(t); }
  };
  const under = await raw(JSON.stringify({ sessionId: "cap", opId: "cap-ok", path: "big.txt", content: "x".repeat(1_000_000) }));
  check("a 1 MB body is accepted", under.status === 200, JSON.stringify(under));
  const over = await raw(JSON.stringify({ sessionId: "cap", opId: "cap-no", path: "huge.txt", content: "x".repeat(9_000_000) }));
  check("a 9 MB body is refused rather than buffered", over.status !== 200, JSON.stringify(over));
  const after = await call("/exec", { sessionId: "cap", opId: "cap-alive", command: "echo alive", timeout: 10 });
  check("and the daemon is still serving afterwards — refusing is not crashing",
    after.body.stdout?.trim() === "alive", JSON.stringify(after.body).slice(0, 90));
}

// ── a throw must not poison the op id ───────────────────────────────────────
// An op registers itself in the in-flight map BEFORE it runs, so a retry joins
// rather than double-executing. If the failure path forgets to clear that entry,
// the promise is never settled and every later retry of the id waits on it
// forever — a HANG rather than an error, which is strictly worse: an error is a
// result the agent can act on. The header of the request handler says so; the
// branch that makes it true had never been run.
{
  // A session name too long to mkdir throws AFTER registration, which is the
  // only interesting place to throw.
  const wedge = { sessionId: "s".repeat(400), opId: "wedge-1", command: "echo x", timeout: 10 };
  const first = await call("/exec", wedge);
  check("an op that throws after registering answers with the error",
    first.status === 500 && /ENAMETOOLONG|too long/.test(first.body.error ?? ""), JSON.stringify(first).slice(0, 110));
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  let retry;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(wedge),
    });
    retry = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) { retry = { status: "HUNG", err: String(e?.name ?? e) }; }
  finally { clearTimeout(timer); }
  check("and RETRYING that id answers instead of hanging on a promise nobody settled",
    retry.status !== "HUNG", `${JSON.stringify(retry).slice(0, 90)} after ${Date.now() - t0}ms`);

  // The sharper case: a second request that JOINED the first while it was still
  // running. It is awaiting the in-flight promise, so clearing the map is not
  // enough — somebody has to settle it, or that caller waits forever for a
  // result that already failed. Fired concurrently, because the join only
  // happens in the window between registration and the throw.
  const both = await Promise.all([0, 1].map(async (n) => {
    const c = new AbortController();
    const timer2 = setTimeout(() => c.abort(), 6000);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
        method: "POST", signal: c.signal,
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ ...wedge, opId: "wedge-join" }),
      });
      return { n, status: res.status, joined: (await res.json().catch(() => ({}))).joined ?? false };
    } catch (e) { return { n, status: "HUNG", err: String(e?.name ?? e) }; }
    finally { clearTimeout(timer2); }
  }));
  check("a caller that JOINED a failing op is settled with the failure, not left waiting",
    both.every((r) => r.status !== "HUNG"), JSON.stringify(both));
}

// ── /health, which celldctl polls to decide the daemon is up ────────────────
// The condition auditor found three guards here that no claim reached: the
// health route itself, the method check behind it, and the auth check in front.
// Disabling the health route makes /health fall through to the POST check and
// answer 405 — celldctl would then poll a daemon that is running and never see
// it come up, on every deploy. Nothing failed, because nothing asked.
{
  const get = async (path, token = "test-token") => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const h = await get("/health");
  check("/health answers 200 with ok:true — this is what celldctl polls to call a node up",
    h.status === 200 && h.body.ok === true, JSON.stringify(h));

  // GET is answered ONLY for the introspection routes. Everything else is a
  // command and needs a POST; without that check a GET reaches readBody and
  // fails as a parse error instead of a method error.
  const g = await get("/exec");
  check("and a GET to a command route is 405, not a parse failure",
    g.status === 405, JSON.stringify(g));

  // Health is BEHIND the token. It reports that this daemon, with this work
  // root, is alive — which is not something an unauthenticated caller should be
  // able to confirm. Moving the route above the auth check would be an easy
  // 'fix' for a polling problem; this is what stops it.
  const anon = await get("/health", null);
  check("and /health is behind the token like everything else",
    anon.status === 401, JSON.stringify(anon));
}

server.close();
console.log(bad ? `\n  ${bad} failure(s)` : "\n  the daemon boundary holds");
process.exit(bad ? 1 : 0);
