// OFF-BY-ONE, ON THE AGENT SIDE.
//
// The bindings gained this auditor first and 24 of 38 boundaries survived being
// moved by one — every limit in that package was pinned on its rejecting side
// and never on its accepting side. Nothing said the agent would be different;
// nothing had looked.
//
// Same narrow mutation, a boundary SHIFT and not a negation:
//
//   >= -> >     <= -> <     > -> >=     < -> <=
//
// mutate-guards.mjs audits `throw` and mutate-conditions.mjs audits `if`. A
// shifted comparison removes neither, so both report a clean file over code
// that is off by one.
//
// EXPENSIVE, like its sibling: every mutation rebuilds the bundle and runs the
// suites that import the file. 21 boundaries across seven files, so it takes
// arguments — matched as substrings of the path, with a miss an error rather
// than a silent full run.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { literalMask } from "../../tools/js-mask.mjs";
import { canary, nodeArgsFor, suitesFor } from "./suite-map.mjs";

const run = promisify(execFile);
const HERE = new URL("..", import.meta.url).pathname;

const ALL_TARGETS = [
  ...readdirSync(`${HERE}src`).filter((f) => f.endsWith(".js")).map((f) => `${HERE}src/${f}`),
  `${HERE}daemon/server.js`,
  `${HERE}celldctl.mjs`,
];
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

const SHIFT = { ">=": ">", "<=": "<", ">": ">=", "<": "<=" };

/** Every relational operator that is code, not comment, string, template or regex. */
function boundarySpans(src) {
  const skip = literalMask(src);
  const spans = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (skip[i]) continue;
    if (c !== "<" && c !== ">") continue;
    if (prev === "=" || prev === "<" || prev === ">" || prev === "!") continue;
    if (src[i + 1] === "<" || src[i + 1] === ">") { i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=") { spans.push([i, i + 2, two]); i++; }
    else spans.push([i, i + 1, c]);
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

// Restore on a signal, not only on the normal path — the same hazard that left
// src/pitools.js modified in the working tree when the condition auditor was
// killed mid-mutation. A slow mutator WILL be interrupted.
let inFlight = null;
const putBack = () => { if (inFlight) { try { writeFileSync(inFlight.file, inFlight.original); } catch { /* best effort */ } inFlight = null; } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { putBack(); process.exit(130); });
process.on("exit", putBack);

async function canaryFails(target, original, suites) {
  writeFileSync(target, canary(original));
  const built = await build();
  const noticed = built ? !(await suitesPass(suites)) : true;
  writeFileSync(target, original);
  await build();
  return noticed;
}

const survivors = [], explained = [], unverified = [];
let mutated = 0, unbuildable = 0;

for (const TARGET of TARGETS) {
  const original = readFileSync(TARGET, "utf8");
  const suites = suitesFor(TARGET);
  const spans = boundarySpans(original);
  if (spans.length === 0) continue;
  inFlight = { file: TARGET, original };
  const verified = await canaryFails(TARGET, original, suites);
  inFlight = null;
  if (!verified) {
    unverified.push({ file: TARGET.slice(HERE.length), suites });
    process.stdout.write("?");
    continue;
  }
  for (const [from, to, op] of spans) {
    inFlight = { file: TARGET, original };
    writeFileSync(TARGET, original.slice(0, from) + SHIFT[op] + original.slice(to));
    mutated++;
    const built = await build();
    const survived = built ? await suitesPass(suites) : false;
    writeFileSync(TARGET, original);
    await build();
    inFlight = null;
    if (!built) { unbuildable++; process.stdout.write("x"); continue; }
    if (survived) {
      const line = original.slice(0, from).split("\n").length;
      const before = original.slice(0, from).split("\n").slice(-5).join("\n");
      const m = /AUDIT-EQUIVALENT:\s*(\S.*)/.exec(before);
      const ctx = original.slice(0, to).split("\n").pop().trim().slice(-70);
      const entry = { file: TARGET.slice(HERE.length), line, op, shift: SHIFT[op], ctx };
      if (m) explained.push({ ...entry, why: m[1].trim() });
      else survivors.push(entry);
    }
    process.stdout.write(survived ? "!" : ".");
  }
}

console.log(`\n\n  ${mutated} boundaries shifted, ${unbuildable} unbuildable, ${survivors.length} survived\n`);
if (unverified.length) {
  console.log("  NOT AUDITED — the canary did not fail these suites, so a survivor here would");
  console.log("  mean 'nothing ran' rather than 'nothing depends on it':\n");
  for (const u of unverified) console.log(`    ${u.file}  (${u.suites.join(", ") || "no suite"})`);
  console.log("");
}
if (survivors.length === 0) {
  console.log("  every boundary in the agent is pinned by a claim, or explained below.");
} else {
  console.log("  UNPINNED BOUNDARIES — no claim fails when these move by one:\n");
  for (const s of survivors) console.log(`    ${s.file}:${s.line}  ${s.op} -> ${s.shift}\n      ${s.ctx}`);
}
if (explained.length) {
  console.log(`\n  EQUIVALENT BY CONSTRUCTION (${explained.length}):\n`);
  for (const e of explained) console.log(`    ${e.file}:${e.line}  ${e.op} -> ${e.shift}\n      ${e.why}`);
}
process.exit(survivors.length ? 1 : 0);
