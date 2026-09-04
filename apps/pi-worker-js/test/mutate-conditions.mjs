// THE GUARDS THAT ARE NOT THROWS.
//
// mutate-guards.mjs audits `throw` statements, and worker.js has ZERO of them
// across 1002 lines and 48 `if` guards — so the audit says nothing at all about
// the agent's most important file. Its guards are early returns, alarm claims,
// 409 refusals, the unbilled-path set: conditionals, every one.
//
// This disables each condition in turn (`if (X)` -> `if (false)`) and runs the
// suites that drive the worker. A survivor means the guarded branch is never
// required by any claim.
//
// A survivor is NOT automatically a bug, and the list is meant to be read
// rather than counted: some branches are genuinely optional (a broadcast that
// nobody is listening to), while others are the difference between a refusal
// and silent corruption. Telling those apart is the point.
//
// The suites import dist/worker.js, so each mutant is rebuilt before running.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { commentMask } from "../../tools/js-mask.mjs";

const run = promisify(execFile);
const HERE = new URL("..", import.meta.url).pathname;
// EVERY SOURCE, not only the worker. worker.js was audited first because it had
// zero throws and so was invisible to mutate-guards; the other eleven files
// carry 61 more conditions that had never been audited either.
//
// And two files that are not under src/ at all. daemon/server.js is the tool
// daemon every remote ExecutionEnv talks to, celldctl.mjs is what deploys a
// cell — 878 lines between them, both with suites, neither ever audited,
// because TARGETS was a readdir of one directory.
import { readdirSync } from "node:fs";
import { ALL_SUITES, canary, nodeArgsFor, suitesFor } from "./suite-map.mjs";
const ALL_TARGETS = [
  ...readdirSync(`${HERE}src`).filter((f) => f.endsWith(".js")).map((f) => `${HERE}src/${f}`),
  `${HERE}daemon/server.js`,
  `${HERE}celldctl.mjs`,
];

// A FULL RUN IS AN HOUR AND A HALF, so it can be pointed at one file.
//
// Every mutation rebuilds the bundle and runs up to nine suites; 280 of them is
// not something to sit through when the question is "what does the file I just
// added to the target list say?". Arguments are matched as substrings of the
// path, and one that matches nothing is an error rather than a silent full run
// — a typo that quietly audited everything would waste the same ninety minutes
// it was meant to save.
const argv = process.argv.slice(2);
const TARGETS = argv.length
  ? argv.map((a) => {
      const hits = ALL_TARGETS.filter((t) => t.includes(a));
      if (hits.length === 0) {
        console.error(`no target matches ${JSON.stringify(a)}\n  known: ${ALL_TARGETS.map((t) => t.slice(HERE.length)).join(", ")}`);
        process.exit(2);
      }
      return hits;
    }).flat()
  : ALL_TARGETS;

/** Every `if (` at the start of a statement, with the span of its condition. */
function conditionSpans(src) {
  const spans = [];
  // A conditional written inside a comment is prose, not a guard. Not a live
  // problem in this package today — measured, zero matches — but worker.js is
  // more comment than code and the bindings auditor already reported one.
  const comment = commentMask(src);
  const re = /(^|[\s;{}])if\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("(", m.index + m[0].length - 1);
    let i = open, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const c = src[i], prev = src[i - 1];
      if (quote) { if (c === quote && prev !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    if (i < src.length) {
      if (!comment[m.index]) spans.push([open + 1, i]);
      re.lastIndex = i;
    }
  }
  return spans;
}

async function build() {
  try { await run("npm", ["run", "build"], { cwd: HERE, timeout: 120_000 }); return true; }
  catch { return false; }
}

async function suitesPass(suites) {
  for (const s of suites) {
    try { await run(process.execPath, [...nodeArgsFor(s), `test/${s}`], { cwd: HERE, timeout: 180_000 }); }
    catch { return false; }
  }
  return true;
}

// RESTORE ON A SIGNAL, NOT ONLY ON THE NORMAL PATH.
//
// This auditor was killed mid-mutation and left src/pitools.js modified in the
// working tree — the exact hazard tools/mutate.mjs was written to prevent, in
// the one place that did not use it. A long-running mutator WILL be interrupted:
// it is slow by nature and it holds the machine's test ports while it runs.
let inFlight = null;   // { file, original }
const putBack = () => { if (inFlight) { try { writeFileSync(inFlight.file, inFlight.original); } catch { /* best effort */ } inFlight = null; } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { putBack(); process.exit(130); });
process.on("exit", putBack);

const survivors = [];
const explained = [];
const unverified = [];
let mutated = 0, unbuildable = 0;

/**
 * Before trusting a file's suite list, break the file completely and check that
 * the list NOTICES.
 *
 * Every wrong finding this tool has produced came from running suites that
 * could not reach the mutated code — a survivor then means "nothing ran", not
 * "nothing depends on it", and the two are indistinguishable in the output. A
 * canary makes them distinguishable: if a module that throws on load does not
 * fail these suites, the mapping is wrong and this file's results are dropped
 * rather than reported.
 *
 * It matters most for daemon/server.js and celldctl.mjs, whose suites are
 * declared by hand because they are SPAWNED rather than imported. Those are
 * exactly the entries that could rot silently.
 */
async function canaryFails(target, original, suites) {
  writeFileSync(target, canary(original));
  const built = await build();
  const noticed = built ? !(await suitesPass(suites)) : true;
  writeFileSync(target, original);
  await build();
  return noticed;
}

for (const TARGET of TARGETS) {
 const original = readFileSync(TARGET, "utf8");
 const suites = suitesFor(TARGET);
 inFlight = { file: TARGET, original };
 const verified = await canaryFails(TARGET, original, suites);
 inFlight = null;
 if (!verified) {
   unverified.push({ file: TARGET.slice(HERE.length), suites });
   process.stdout.write("?");
   continue;
 }
 for (const [from, to] of conditionSpans(original)) {
  const cond = original.slice(from, to).replace(/\s+/g, " ").trim();
  // `if (false)` on a condition that is already constant proves nothing.
  if (cond === "false" || cond === "true") continue;
  inFlight = { file: TARGET, original };
  writeFileSync(TARGET, `${original.slice(0, from)}false${original.slice(to)}`);
  if (!(await build())) { writeFileSync(TARGET, original); inFlight = null; unbuildable++; process.stdout.write("x"); continue; }
  mutated++;
  const survived = await suitesPass(suites);
  writeFileSync(TARGET, original);
  inFlight = null;
  if (survived) {
    const line = original.slice(0, from).split("\n").length;
    // A branch can be UNREACHABLE-BUT-CORRECT: `if (!rec) return undefined`
    // inside a try/catch that already answers undefined when rec is missing.
    // Disabling it changes nothing and no claim can be written for it, so it
    // sits in this list forever and every reader re-derives the same
    // conclusion. An AUDIT-EQUIVALENT note in the lines above moves it out of
    // the findings and into a section that prints WHY — and a marker with no
    // reason after it does not count, so it cannot be used to silence anything.
    const before = original.slice(0, from).split("\n").slice(-5).join("\n");
    const m = /AUDIT-EQUIVALENT:\s*(\S.*)/.exec(before);
    const entry = { file: TARGET.slice(HERE.length), line, cond: cond.slice(0, 88) };
    if (m) explained.push({ ...entry, why: m[1].trim() });
    else survivors.push(entry);
  }
  process.stdout.write(survived ? "!" : ".");
 }
}
await build();

console.log(`\n\n  ${mutated} conditions disabled, ${unbuildable} unbuildable, ${survivors.length} survived\n`);
if (unverified.length) {
  console.log("  NOT AUDITED — a module that throws on load did not fail these suites, so the");
  console.log("  mapping is wrong and any survivor from this file would be noise:\n");
  for (const u of unverified) console.log(`    ${u.file}  (suites: ${u.suites.join(", ") || "none"})`);
  console.log("");
}
if (survivors.length === 0) console.log("  every conditional guard in the agent sources is required by a claim, or explained below.");
else {
  console.log("  SURVIVORS — disabling these breaks no claim. Read, do not just count:\n");
  for (const s of survivors) console.log(`    ${s.file}:${s.line}\n      if (${s.cond})`);
  // WHAT THIS AUDIT CANNOT SEE, said here rather than left for the reader to
  // rediscover. Only the node suites run: e2e.sh, streaming.sh, crash.sh,
  // platinum.sh and eviction.sh need a live container and a bucket, and a
  // mutation run that started one per condition would take a day.
  //
  // So a branch reachable ONLY through `celldctl up` or `deploy` — the poll
  // loops, the restart path, the exit-code handling around docker run — appears
  // in the list above with nothing behind it, and that is a statement about
  // this tool, not about the code. The honest options for one of those are to
  // give it a claim a node suite can reach (which is what deployOutcome and
  // pollDelay were extracted for) or to say out loud that it is untested.
  console.log(`\n  Audited against the node suites only: ${ALL_SUITES.join(", ")}.`);
  console.log("  A branch reachable only through a Docker suite will appear above regardless.");
}
if (explained.length) {
  console.log(`\n  EQUIVALENT BY CONSTRUCTION (${explained.length}) — no claim can fail on these, and here is why:\n`);
  for (const e of explained) console.log(`    ${e.file}:${e.line}  if (${e.cond})\n      ${e.why}`);
}
process.exit(0);
