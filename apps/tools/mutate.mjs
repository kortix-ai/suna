#!/usr/bin/env node
// MUTATE A FILE, RUN A COMMAND, ALWAYS PUT IT BACK.
//
// Written after doing this by hand dozens of times and hitting both ways it
// goes wrong:
//
//   THE ANCHOR DOES NOT MATCH. The patch silently does nothing, the command
//   runs against unmodified code, and "0 failures" is read as "the guard is
//   covered". This has produced at least three wrong conclusions in this repo —
//   the worst kind, because the wrong answer looks like the right one.
//
//   THE RESTORE DOES NOT RUN. A `cp` with a relative path from the wrong
//   directory, an early exit, a timeout. The mutation stays in the working
//   tree — and once that was a file in apps/api, which is far worse than any
//   failing test.
//
// So: the anchor must match or nothing runs, and the restore is in a finally
// with a byte-for-byte check that it actually happened.
//
// A MUTATED SOURCE THAT IS BUNDLED MUST BE REBUILT FIRST.
//
// This tool edits a source file and runs a command. If the suite under test
// imports a BUNDLE built from that source, it reads the old bytes and passes —
// a silent false negative, and the one this tool exists to prevent, in a
// different disguise. It cost a real finding: removing the agent's alarm re-arm
// strands four of five queued turns, and every mutation of it read as "0 claims
// failed" because dist/worker.js was never rebuilt.
//
// --build runs a command after the mutation and before the test, and a build
// that fails aborts rather than testing stale output.
//
// Usage:
//   node mutate.mjs --file F --from STR --to STR -- command args...
//   node mutate.mjs --file F --line N --from STR --to STR -- command args...
//   node mutate.mjs --file F --from STR --to STR --build "npm run build" -- command args...
//
// Exit code is the command's, so `mutate ... && echo caught-nothing` reads the
// way you expect: a mutant that changes nothing exits 0.
import { execFile } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
if (dashdash === -1) { console.error("mutate: missing `--` before the command"); process.exit(2); }
const opts = {};
for (let i = 0; i < dashdash; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];
const cmd = argv.slice(dashdash + 1);
if (!opts.file || opts.from === undefined || opts.to === undefined || cmd.length === 0) {
  console.error("mutate: need --file, --from, --to and a command after --");
  process.exit(2);
}

const original = readFileSync(opts.file, "utf8");

// WRITTEN BY RENAME, AND RESTORED ON A SIGNAL.
//
// writeFileSync truncates and then writes. A process killed inside that window
// leaves the source at ZERO BYTES, and this tool had no handler for it: a guard
// run was interrupted and bindings/r2.js — 20476 bytes of R2 client — was found
// empty afterwards, with the next run reporting its two entries as "anchor not
// found" rather than "the file is gone". Nothing was committed, because git had
// the file, but the diagnosis cost a round.
//
// rename(2) is atomic within a filesystem, so a reader sees the old file or the
// new one and never a half-written one. The signal handlers are the other half:
// the agent's auditors grew them after being killed mid-mutation, and the tool
// they all call did not have them.
const TMP = `${opts.file}.mutate-tmp`;
const put = (content) => { writeFileSync(TMP, content); renameSync(TMP, opts.file); };
let restored = false;
const putBack = () => {
  if (restored) return;
  restored = true;
  try { put(original); } catch { /* best effort, the message below still prints */ }
  try { unlinkSync(TMP); } catch { /* already renamed away */ }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { putBack(); process.exit(130); });
}

function apply() {
  if (opts.line !== undefined) {
    const lines = original.split("\n");
    const i = Number(opts.line) - 1;
    if (!lines[i] || !lines[i].includes(opts.from)) {
      throw new Error(`--from not present on line ${opts.line} of ${opts.file}\n  line: ${lines[i] ?? "(out of range)"}`);
    }
    lines[i] = lines[i].replace(opts.from, opts.to);
    return lines.join("\n");
  }
  const count = original.split(opts.from).length - 1;
  if (count === 0) throw new Error(`--from not found in ${opts.file}: ${opts.from.slice(0, 90)}`);
  if (count > 1) throw new Error(`--from matches ${count} times in ${opts.file}; use --line to disambiguate`);
  return original.replace(opts.from, opts.to);
}

let code = 0;
try {
  const mutated = apply();               // throws if the anchor is wrong — before anything runs
  put(mutated);
  if (opts.build) {
    try { await run("sh", ["-c", opts.build], { maxBuffer: 32 * 1024 * 1024 }); }
    catch (e) { throw new Error(`--build failed, so the command would have tested stale output: ${String(e.stderr ?? e.message).slice(0, 200)}`); }
  }
  try {
    const r = await run(cmd[0], cmd.slice(1), { maxBuffer: 32 * 1024 * 1024 });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
  } catch (e) {
    process.stdout.write(e.stdout ?? "");
    process.stderr.write(e.stderr ?? "");
    code = typeof e.code === "number" ? e.code : 1;
  }
} catch (e) {
  console.error(`mutate: ${e.message}`);
  code = 2;
} finally {
  putBack();
  // Verified, not assumed. A restore that silently failed is how a mutation
  // ends up committed.
  // Rebuild from the restored source as well: a clean tree with a mutated
  // bundle is the same false negative one step later.
  if (opts.build) { try { await run("sh", ["-c", opts.build], { maxBuffer: 32 * 1024 * 1024 }); } catch { /* reported below */ } }
  const now = readFileSync(opts.file, "utf8");
  if (now !== original) {
    console.error(`mutate: RESTORE FAILED for ${opts.file} — the file is still modified`);
    process.exit(3);
  }
}
process.exit(code);
