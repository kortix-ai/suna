#!/usr/bin/env node
// DO THE DOCKER SUITES ACTUALLY PROVE WHAT THEY SAY?
//
// mutate-conditions and mutate-guards cannot run e2e, streaming, crash,
// platinum or eviction — they need a live container and a bucket, and one
// mutation per condition would take a day. Their own footer says so, which
// leaves the question open rather than answered: those five suites make the
// claims that matter most, and nothing checked that any of them could fail.
//
// Checking it by hand found three that could not:
//
//   streaming grepped the WHOLE container log for a constant string, and `up`
//     keeps the node alive between suites — one successful run satisfied it
//     forever
//   eviction identified "the cell I just made" with `tail -1` over that same
//     shared log, and measured a stranger's cell
//   crash compared a run counter that lives in the daemon it SIGKILLs, so both
//     readings were 0 and `0 = 0` passed whatever the code did
//
// So the check is written down. Each entry breaks the code one headline claim
// is about and asserts the suite NOTICES. It is slow — a build, a deploy and a
// full suite per entry — so it is not in all.sh; run it when the Docker suites
// change, or when a claim starts looking too comfortable.
//
//
// "CAUGHT" IS NOT ENOUGH ON ITS OWN. A mutation that fails to build, or that
// trips an unrelated claim in a suite with a dozen of them, prints exactly the
// same word — and then the claim this entry names has been proved by nothing.
// Each entry says which claim ought to fail, and a catch by anything else is
// reported as WRONG-CLAIM rather than counted.
//
// That is not hypothetical here. The KV durability entry reported CAUGHT while
// the KV claims PASSED: the mutation broke an unrelated queue claim, and the
// value "surviving eviction" was one an earlier run had left in the bucket.
// Verdicts come from tools/mutant.mjs, because the four times I classified a
// mutation by hand in a shell wrapper, I got it wrong four times.
//
// ONE ENTRY WAS REMOVED RATHER THAN LEFT FLAKY. The daemon's ledger replay used
// to be checked here through crash.sh, and it reported NOT PROVEN about half the
// time: that branch is only reached when the SIGKILL lands after the command
// finished, and the suite deliberately does not control that race.
//
// The branch is not uncovered. Measured, twice: removing it fails
// daemon-persist, daemon-safety and ledger-parity, all deterministically. So
// what the entry added was a NOT PROVEN section that is usually noise — and a
// report with standing noise in it is one people stop reading, which is the
// same failure as a guard that fires when nothing is wrong.
//
// What belongs here is a claim whose ONLY proof is the Docker suite.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { verdict } from "../../tools/mutant.mjs";

const run = promisify(execFile);
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const strip = (t) => String(t ?? "").replace(ANSI, "");
const HERE = new URL("..", import.meta.url).pathname;
const CELLD = new URL("../..", import.meta.url).pathname;

const SECRET = JSON.parse(readFileSync(`${HERE}agent.config.json`, "utf8"))
  .targets.local.credentials.secret_key;

/** One headline claim per entry, and the smallest change that should break it. */
const CHECKS = [
  { claim: "the transcript is user,assistant,toolResult,assistant", expect: new RegExp("unexpected transcript"), suite: "e2e.sh",
    file: "src/worker.js",
    from: 'for (const r of event.toolResults ?? []) this.saveMessage("toolResult", r);', to: ";" },
  { claim: "the assistant message reaches the transcript", expect: new RegExp("unexpected transcript"), suite: "e2e.sh",
    file: "src/worker.js",
    from: "if (event.message) this.saveMessage(\"assistant\", event.message);", to: ";" },
  { claim: "every tool call is in the op ledger", expect: new RegExp("op ledger holds"), suite: "e2e.sh",
    file: "src/pitools.js",
    from: "        log.begin(toolCallId, tool.name, detailOf(tool.name, input));", to: "        ;" },
  { claim: "concurrent prompts do not interleave", expect: new RegExp("interleaved transcript"), suite: "e2e.sh",
    file: "src/worker.js",
    from: "          AND NOT EXISTS (SELECT 1 FROM turns WHERE status='running')", to: "" },
  { claim: "one session's events do not reach another's watcher", expect: new RegExp("cross-session leakage"), suite: "streaming.sh",
    file: "src/worker.js",
    from: 'const name = url.searchParams.get("c") ?? "default";', to: 'const name = "default";' },
  { claim: "a scope refusal is an error, not an empty success", expect: new RegExp("scope refusal|sandbox_scope"), suite: "platinum.sh",
    file: "src/execenv.platinum.js",
    from: "if (r.status !== 200) return { ok: false, status: r.status, error: r.json?.error ?? `exec ${r.status}`, code: r.json?.code };",
    to: 'if (r.status !== 200) return { ok: true, stdout: "", stderr: "", exitCode: 0 };' },
  { claim: "requests are metered", expect: new RegExp("meter did not count"), suite: "eviction.sh",
    file: "src/worker.js",
    from: '    if (!UNBILLED_PATHS.has(url.pathname)) this.meter("requests");', to: "    ;" },
  // NOT A CODE MUTATION — a STATE one, and the same question. "A new process
  // read all N messages back from the bucket" is a claim about where the
  // transcript comes from, and the way to test that is to take the bucket away
  // between the kill and the resume. If it still passes, it was never reading
  // from there.
  //
  // The bindings' durability suite failed exactly this test one round ago: its
  // KV claim passed with the write disabled, because the value came from an
  // earlier run. This one fails properly — 8 before, 0 after — so the round trip
  // through object storage is real.
  { claim: "the transcript really comes from the bucket, not from a surviving container",
    expect: new RegExp("transcript did not survive"), suite: "e2e.sh", file: "test/e2e.sh",
    from: 'docker kill "$CONTAINER" >/dev/null\nstart_cell',
    to: 'docker kill "$CONTAINER" >/dev/null\n'
      + 'docker run --rm --network host --entrypoint sh quay.io/minio/mc -c '
      + `"mc alias set m http://127.0.0.1:19000 celldev ${SECRET} >/dev/null 2>&1; `
      + 'mc rm --recursive --force m/cells/orgs/demo/cells >/dev/null 2>&1; true" >/dev/null 2>&1\n'
      + 'start_cell' },

  // THE OTHER TWO STANDING ITEMS, probed the same way: does the claim depend on
  // the thing it names, or on something incidental?
  //
  // Idle eviction is the one with a history. celldctl carried a note saying it
  // "did nothing at CELLD_IDLE_EVICT_S=3", written by looking for a log line
  // celld never writes; the epoch/fresh pair showed it does evict. A correction
  // of a previous wrong belief deserves to be provable, so: run the same section
  // WITHOUT the variable and the claim has to fail. It does — fresh=true and
  // nothing else, meaning the cell was made and never evicted.
  { claim: "idle eviction is caused by CELLD_IDLE_EVICT_S, not by something incidental",
    expect: new RegExp("idle cell was never evicted"), suite: "eviction.sh", file: "test/eviction.sh",
    from: "if CELLD_IDLE_EVICT_S=3 node celldctl.mjs up >/dev/null 2>&1; then",
    to: "if node celldctl.mjs up >/dev/null 2>&1; then" },

  // And scale-to-zero: without the resident cap there is no memory pressure, so
  // nothing is evicted and the suite says so in its own words — "nothing below
  // would mean anything".
  { claim: "the evict-and-rebuild claims rest on a real eviction",
    expect: new RegExp("NEVER EVICTED"), suite: "eviction.sh", file: "test/eviction.sh",
    from: 'CELLD_MAX_RESIDENT_CELLS=1 node celldctl.mjs up >/dev/null 2>&1 || { echo "  SKIP: could not start a capped node"; exit 0; }',
    to: 'node celldctl.mjs up >/dev/null 2>&1 || { echo "  SKIP: could not start a capped node"; exit 0; }' },

  // PINNED TO THE CLAIM THAT ACTUALLY PROVES IT. Disabling the broadcast leaves
  // the consistency claim in 4b passing — after an eviction both sides are empty
  // and that is consistent — so what catches a dead broadcast is 4c, on a fresh
  // socket. Without this entry, deleting 4c as "redundant with 4b" would go
  // unnoticed.
  { claim: "a watcher on a fresh socket receives the turn's events",
    expect: new RegExp("saw no turn events"), suite: "eviction.sh", file: "src/worker.js",
    from: "      try { ws.send(payload); } catch { /* closing; the runtime will drop it */ }",
    to: "      try { void payload; } catch { /* closing; the runtime will drop it */ }" },

  { claim: "the meter's write reaches SQLite, not just the call site", expect: new RegExp("meter did not count"),
    suite: "eviction.sh", file: "src/worker.js",
    from: '      "INSERT INTO meter(k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + ?",',
    to: '      "SELECT ? AS k, ? AS n, ? AS m",' },

  // THE DURABILITY HALF, ON ITS OWN.
  //
  // The two entries above both stop the counting, so both fail at "the meter did
  // not count" and neither one ever reaches the round-trip claim. That left the
  // headline — THE COUNT SURVIVED THE ROUND TRIP THROUGH OBJECT STORAGE — pinned
  // by nothing: it could have been deleted, or been vacuously true, and the
  // suite would still have gone green under every mutant.
  //
  // This one counts normally and loses the table on rebuild, so 5 is read before
  // the eviction and 0 after. Measured: it fails at the round-trip claim and NOT
  // at "did not count", which is what makes the two halves separable.
  { claim: "the counted requests survive the round trip through object storage",
    expect: new RegExp("meter LOST counts across a real eviction"),
    suite: "eviction.sh", file: "src/worker.js",
    from: "    this.sql.exec(`CREATE TABLE IF NOT EXISTS meter (",
    to: '    this.sql.exec("DROP TABLE IF EXISTS meter"); this.sql.exec(`CREATE TABLE IF NOT EXISTS meter (' },
  // SCALE TO ZERO, PINNED BY REMOVING THE CAUSE FROM ITS OWN SECTION.
  //
  // A state mutation, not a code one: the anchor reaches into 4f's `up` and not
  // 4d's, which is written identically. That matters — a mutation that killed
  // both would be caught by 4d and say nothing about whether the four-cell
  // claim can fail at all. Measured: 4d still passes and only 4f fails.
  { claim: "residency reaches zero when nothing is asking",
    expect: new RegExp("of 4 idle cells were evicted"),
    suite: "eviction.sh", file: "test/eviction.sh",
    from: "if CELLD_IDLE_EVICT_S=3 node celldctl.mjs up >/dev/null 2>&1; then\n  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)\n  ID_BEFORE=",
    to: "if node celldctl.mjs up >/dev/null 2>&1; then\n  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)\n  ID_BEFORE=" },
  // THE CELL'S BASH REACHES PLATINUM'S /exec — measured against dev, not a stub.
  //
  // The first attempt at this entry mutated tools.platinum.js and SURVIVED:
  // that module's bash is retired (pitools.js routes bash through the
  // ExecutionEnv in execenv.platinum.js), so the mutation touched code the
  // turn never ran. This one mutates the call that actually fires. Its failure
  // text is Platinum dev's own 404, which is also proof the request got there.
  // SKIPs — reported as `skipped`, not `silent` — when no dev token is present.
  { claim: "the cell's bash really reaches Platinum's /exec on dev",
    expect: new RegExp("no such route|not_found"),
    suite: "dev-e2e.sh", file: "src/execenv.platinum.js",
    from: 'const r = await api("POST", "/exec", { body: { cmd: command, timeout_ms: Math.min(Math.max(timeoutMs, 100), 300_000) }, signal });',
    to:   'const r = await api("POST", "/exec-nope", { body: { cmd: command, timeout_ms: Math.min(Math.max(timeoutMs, 100), 300_000) }, signal });' },
  // THE WORKSPACE CWD REACHES THE TURN'S TOOLS. Two attempts at this survived:
  // one mutated tools.platinum.js (retired), one mutated the cwd in
  // executionEnvFor, which is not the builder the agent's tools use — the turn
  // kept resolving /root while that copy said /home/user. The default now lives
  // in ONE function, workspaceCwd(), and this pins it: forcing /home/user makes
  // the cell resolve a relative read under the wrong directory, and dev-e2e's
  // probe says so by name. This is the first cell->dev failure, as a guard.
  { claim: "PT_WORKSPACE_CWD reaches the tools the turn actually runs",
    expect: new RegExp("resolved /home/user/does-not-exist.txt"),
    suite: "dev-e2e.sh", file: "src/pitools.js",
    from: 'export const workspaceCwd = (env) => env.PT_WORKSPACE_CWD || "/home/user";',
    to:   'export const workspaceCwd = (env) => "/home/user";' },
];

/**
 * Prune the cells this run creates.
 *
 * Sixteen entries, each a full e2e or eviction run, each making its own cells and
 * leaving them. The bindings version of this file has to reset its store for
 * CORRECTNESS — its fixture uses a fixed name, and a mutant poisoned it. Here
 * every suite names its cell with $$ or $RANDOM, so nothing is poisoned and the
 * cost is only growth: measured 48 MiB and 37,723 objects of test residue on
 * this machine before the first prune.
 *
 * Deployments are untouched. They are what a node loads at startup.
 */
const prune = async () => { await run(process.execPath, [`${HERE}clean-store.mjs`], { cwd: HERE }).catch(() => {}); };

// An optional substring filter, so one entry can be re-verified in a minute
// rather than re-running thirteen docker suites to check a single edit. No
// argument means all of them, which is what CI and `npm run docker-guards` do.
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith("-")).join(" ").toLowerCase();
const SELECTED = ONLY ? CHECKS.filter((c) => c.claim.toLowerCase().includes(ONLY)) : CHECKS;
if (ONLY && SELECTED.length === 0) {
  console.error(`no entry matches ${JSON.stringify(ONLY)}`);
  process.exit(2);
}

const bad = [];
for (const c of SELECTED) {
  process.stdout.write(`  ${c.claim.padEnd(58)} `);
  let out = "", code = 0;
  try {
    const r = await run(process.execPath, [
      `${CELLD}tools/mutate.mjs`, "--file", `${HERE}${c.file}`, "--from", c.from, "--to", c.to,
      "--build", "npm run --silent build", "--", "sh", "-c", `cd ${HERE} && ./test/${c.suite}`,
    ], { cwd: HERE, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
    out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    code = typeof e.code === "number" ? e.code : 1;
  }
  const v = verdict({ code, output: out });
  const failing = strip(out).split("\n").filter((l) => /^\s{1,4}FAIL\s/.test(l)).map((l) => l.replace(/^\s*FAIL\s*/, "").trim());
  const right = v.outcome === "caught" && (!c.expect || failing.some((f) => c.expect.test(f)));
  const label = right ? "CAUGHT" : v.outcome === "caught" ? "WRONG-CLAIM" : v.outcome.toUpperCase();
  console.log(`${label.padEnd(11)} ${c.suite}  ${failing[0] ?? ""}`.trimEnd());
  if (!right) bad.push({ ...c, v, failing });
}

await prune();

console.log("");
if (bad.length === 0) {
  console.log(`  every one of the ${SELECTED.length} headline claims noticed its mutation.`);
} else {
  console.log("  NOT PROVEN — these claims did not notice the code they are about changing:\n");
  for (const b of bad) {
    const why = b.v.outcome !== "caught"
      ? `${b.v.outcome}: ${b.v.detail}`
      : `something failed, but not the claim this entry is about.\n      expected ${b.expect}\n      got: ${(b.failing ?? []).join(" | ") || "no named failure"}`;
    console.log(`    ${b.suite}: ${b.claim}\n      ${why}`);
  }
}
process.exit(bad.length ? 1 : 0);
