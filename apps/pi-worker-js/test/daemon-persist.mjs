// DOES THE LEDGER SURVIVE THE DAEMON?
//
// A cell is restarted in seconds after a crash and retries with the same
// toolCallId. If the daemon restarted in that window and forgot the op, the
// retry re-ran the command — the double execution the whole design exists to
// prevent, one layer down from where it was fixed. The ledger is on disk now,
// and this proves the two cases that matter:
//
//   completed before the restart  -> the retry is answered from disk, not run
//   IN FLIGHT at the restart      -> the retry is told the outcome is unknown,
//                                    and is NOT run
//
// In-process, two daemon instances over one work root. No Docker.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=8

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "persist-token";
process.env.WORK_ROOT = "/tmp/daemon-persist-work";
const ROOT = process.env.WORK_ROOT;
const PORT = 7128;
await rm(ROOT, { recursive: true, force: true });
await mkdir(join(ROOT, "s"), { recursive: true });

let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

// Life 2 listens on its own port. The ledger is keyed on the work root, not the
// port, so this is still the same test — and it sidesteps fetch's keep-alive pool
// handing the second life a socket that belonged to the first (ECONNRESET).
let port = PORT;
const call = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { authorization: "Bearer persist-token", "content-type": "application/json" },
    body: JSON.stringify(body),
    // Fail fast and name the step, instead of a 5-minute headers timeout.
    signal: AbortSignal.timeout(4000),
  });
  return res.json();
};
const marker = join(ROOT, "s", "count.txt");
const executions = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const { createDaemon } = await import("../daemon/server.js");

// ── life 1: a command completes ─────────────────────────────────────────────
let server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
await writeFile(marker, "");
const first = await call("/exec", { opId: "survives-1", sessionId: "s", command: "echo x >> count.txt; echo done" });
check("the command ran once in the first daemon", (await executions()) === 1 && /done/.test(first.stdout));
check("the ledger file exists on disk", (await readFile(join(ROOT, ".ledger.sqlite")).catch(() => null)) !== null);

// Plant an op that was IN FLIGHT when this daemon died. A real mid-command
// death is a process kill, which this test cannot do to itself; writing the
// 'running' row the daemon writes at op start is the same state.
{
  // Closed immediately: node:sqlite is synchronous, and an open second
  // connection can hold a lock that blocks the daemon's own writes — which
  // showed up as a request that never answered (HeadersTimeoutError).
  const plant = new DatabaseSync(join(ROOT, ".ledger.sqlite"));
  plant.prepare("INSERT INTO ops(id, status, started_at) VALUES ('inflight-1', 'running', ?)").run(Date.now());
  plant.close();
}

await new Promise((r) => server.close(r));

// ── life 2: a NEW daemon over the SAME work root ────────────────────────────
port = PORT + 1;
server = createDaemon();
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const replay = await call("/exec", { opId: "survives-1", sessionId: "s", command: "echo x >> count.txt; echo done" });
check("a retry after the restart is answered from disk", replay.replayed === true && /done/.test(replay.stdout), JSON.stringify(replay).slice(0, 100));
check("and the command did NOT run again", (await executions()) === 1, `${await executions()} executions`);

const unknown = await call("/exec", { opId: "inflight-1", sessionId: "s", command: "echo x >> count.txt" });
check("an op in flight at the restart is reported as unknown outcome",
  unknown.unknownOutcome === true && /will not be re-run/.test(unknown.error), JSON.stringify(unknown).slice(0, 110));
check("and it was NOT executed", (await executions()) === 1, `${await executions()} executions`);

// A fresh op in the new life still runs normally — a ledger that blocks
// everything after a restart would be worse than one that forgets.
const fresh = await call("/exec", { opId: "fresh-2", sessionId: "s", command: "echo x >> count.txt; echo fresh" });
check("a new op after the restart runs normally", /fresh/.test(fresh.stdout) && (await executions()) === 2);

// A failed op must not become a permanent 'unknown'; it should be retryable.
await call("/nope", { opId: "failed-1", sessionId: "s" });
const retryFailed = await call("/exec", { opId: "failed-1", sessionId: "s", command: "echo ok" });
check("an op that failed before running is a plain retry, not an unknown outcome",
  retryFailed.unknownOutcome !== true && /ok/.test(retryFailed.stdout ?? ""), JSON.stringify(retryFailed).slice(0, 100));

await new Promise((r) => server.close(r));
console.log(bad ? `\n  ${bad} failure(s)` : "\n  the ledger survives the daemon");
process.exit(bad ? 1 : 0);
