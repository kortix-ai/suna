// THE AGENT'S THROWS, AUDITED THE WAY THE BINDINGS' ARE.
//
// mutate-conditions exists because worker.js has zero `throw` statements — its
// guards are early returns and refusals. That is true of worker.js and of
// nothing else here: the other sources, the tool daemon and celldctl carry
// throws that decide whether a bad deploy is refused or shipped, whether a path
// outside the workspace is rejected, whether a secret is allowed into a cell.
// None of them had ever been mutated.
//
// A throw is REPLACED with an empty statement, not deleted. Deleting the line
// leaves `if (!x)` sitting in front of whatever came next, so the following
// statement becomes the guard's body — a bigger and stranger mutation than
// "the check no longer fires", and six of seventeen would not even compile.
//
// SPANS, NOT LINES, and this file already knew that before I rewrote it: a
// scanner that only took throws fitting on one line covered 3 of 9 guards here
// and still printed "every guard is covered by a claim". I overwrote the file
// without reading it and reintroduced exactly that — 17 mutated, 2 silently
// skipped, "0 survived". The scanner below is the original one, restored.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { commentMask } from "../../tools/js-mask.mjs";
import { canary, nodeArgsFor, suitesFor } from "./suite-map.mjs";

const run = promisify(execFile);
const HERE = new URL("..", import.meta.url).pathname;

const TARGETS = [
  ...readdirSync(`${HERE}src`).filter((f) => f.endsWith(".js")).map((f) => `${HERE}src/${f}`),
  `${HERE}daemon/server.js`,
  `${HERE}celldctl.mjs`,
];

/**
 * Whole `throw` statements, however many lines they span, minus any written
 * inside a comment.
 *
 * Scanned from the keyword to the semicolon that closes it at bracket depth
 * zero, tracking strings and template literals so a `;` or a bracket inside a
 * message does not end the statement early.
 */
function throwSpans(src) {
  const spans = [];
  const comment = commentMask(src);
  const re = /(^|[\s;{}])throw\s/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - "throw ".length;
    let i = start, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const c = src[i], prev = src[i - 1];
      if (quote) { if (c === quote && prev !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ";" && depth === 0) break;
    }
    if (i < src.length) {
      if (!comment[start]) spans.push([start, i + 1]);
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
    catch { return false; }   // a suite failed: the guard is covered
  }
  return true;
}

let inFlight = null;
const putBack = () => { if (inFlight) { try { writeFileSync(inFlight.file, inFlight.original); } catch { /* best effort */ } inFlight = null; } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { putBack(); process.exit(130); });
process.on("exit", putBack);

/** Break the file completely; if the suites do not notice, the mapping is wrong. */
async function canaryFails(target, original, suites) {
  writeFileSync(target, canary(original));
  const built = await build();
  const noticed = built ? !(await suitesPass(suites)) : true;
  writeFileSync(target, original);
  await build();
  return noticed;
}

const survivors = [];
const unverified = [];
let mutated = 0;

for (const TARGET of TARGETS) {
  const original = readFileSync(TARGET, "utf8");
  const spans = throwSpans(original);
  if (spans.length === 0) continue;
  const suites = suitesFor(TARGET);
  inFlight = { file: TARGET, original };
  const verified = await canaryFails(TARGET, original, suites);
  inFlight = null;
  if (!verified) {
    unverified.push({ file: TARGET.slice(HERE.length), suites });
    process.stdout.write("?");
    continue;
  }
  for (const [from, to] of spans) {
    inFlight = { file: TARGET, original };
    writeFileSync(TARGET, `${original.slice(0, from)}/* guard removed by mutate-guards */;${original.slice(to)}`);
    if (!(await build())) { writeFileSync(TARGET, original); inFlight = null; process.stdout.write("x"); continue; }
    mutated++;
    const survived = await suitesPass(suites);
    writeFileSync(TARGET, original);
    inFlight = null;
    if (survived) {
      survivors.push({
        file: TARGET.slice(HERE.length),
        line: original.slice(0, from).split("\n").length,
        text: original.slice(from, to).trim().slice(0, 96),
      });
    }
    process.stdout.write(survived ? "!" : ".");
  }
}
await build();

console.log(`\n\n  ${mutated} guards mutated, ${survivors.length} survived\n`);
if (unverified.length) {
  console.log("  NOT AUDITED — a module that throws on load did not fail these suites:\n");
  for (const u of unverified) console.log(`    ${u.file}  (suites: ${u.suites.join(", ") || "none"})`);
  console.log("");
}
if (survivors.length === 0) console.log("  every throw in the agent is covered by a claim.");
else {
  console.log("  SURVIVORS — removing these breaks nothing, so they are untested or unreachable:\n");
  for (const s of survivors) console.log(`    ${s.file}:${s.line}\n      ${s.text}`);
}
process.exit(0);
