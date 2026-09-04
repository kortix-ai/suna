#!/usr/bin/env node
// RUN ONE MUTANT AND SAY WHAT ACTUALLY HAPPENED.
//
// mutate.mjs applies the mutation and restores the file. What it does not do is
// interpret the result, and that interpretation is where this session went
// wrong four separate times — every one a throwaway shell wrapper written
// fresh, and every one reporting something false:
//
//   an anchor that did not match, reported as "SURVIVED" — the suite never ran
//   a missing argument, so the command was `node test/` (a directory), reported
//     as "caught -> 0 claims"
//   a claim counter whose regex did not allow for ANSI colour, so a suite that
//     printed seven claims read as "produced no claims"
//   a helper whose subprocess never started, whose empty output then satisfied
//     a claim about what that output must not contain
//
// The shape is always the same: something did not run, and silence was read as
// a result. So the classification lives here, in the repo, with claims on it,
// rather than being retyped under time pressure.
//
// FOUR OUTCOMES, and the middle two are the ones a hand-rolled wrapper elides:
//
//   anchor    the mutation was never applied (mutate.mjs exits 2). Proves
//             nothing about the guard.
//   skipped   the suite declined to run — a precondition was missing, not a
//             claim that failed to notice. Satisfy it and run again.
//   silent    the command ran and produced NO claims at all. Proves nothing
//             either — and looks exactly like a pass to anything counting
//             failures.
//   survived  claims ran, none failed. The guard is not covered.
//   caught    claims ran and at least one failed. The guard is covered, and the
//             failing claim is named.
//
// Usage:
//   node tools/mutant.mjs --file F --from STR --to STR [--build CMD] -- cmd args...
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = new URL(".", import.meta.url).pathname;

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const strip = (s) => String(s ?? "").replace(ANSI, "");

/** Claim lines look like `  ok  name` or `  PASS name`, in either package's style. */
export const countClaims = (output) => {
  const clean = strip(output);
  const lines = clean.split("\n");
  const claims = lines.filter((l) => /^\s{1,4}(ok|PASS|FAIL)\s/.test(l));
  if (claims.length) {
    const failed = claims.filter((l) => /^\s{1,4}FAIL\s/.test(l));
    return { claims: claims.length, failed: failed.length, first: (failed[0] ?? "").trim() };
  }
  // A RUNNER THAT REPORTS A TALLY INSTEAD OF LINES.
  //
  // bun prints "34 pass / 0 fail" and no per-test line, so this file called a
  // real result "silent: the command produced no claims" and refused to judge
  // it. That is the right answer for a command that produced nothing; it is the
  // wrong answer for one that produced a summary. The billing rails that guard
  // the standing request-counting gap live in apps/api and run under bun, so
  // "cannot read this runner" meant "cannot check those rails at all".
  const pass = /^\s*(\d+)\s+pass\b/m.exec(clean);
  const fail = /^\s*(\d+)\s+fail\b/m.exec(clean);
  if (pass || fail) {
    const p = Number(pass?.[1] ?? 0), f = Number(fail?.[1] ?? 0);
    const named = lines.find((l) => /^\s*\(fail\)/.test(l) || /^error:/.test(l));
    return { claims: p + f, failed: f, first: (named ?? `${f} of ${p + f} failed`).trim() };
  }
  // PYTEST'S TALLY, which is the same shape one word longer: "2 passed, 104
  // deselected in 0.15s" / "1 failed, 105 deselected". The Python SDK's list()
  // filter was verified by hand after this file called its mutation SILENT —
  // the test had failed, pytest had said so, and the verdict could not read it.
  const ppass = /\b(\d+)\s+passed\b/.exec(clean);
  const pfail = /\b(\d+)\s+failed\b/.exec(clean);
  if (ppass || pfail) {
    const p = Number(ppass?.[1] ?? 0), f = Number(pfail?.[1] ?? 0);
    const named = lines.find((l) => /^FAILED\s/.test(l));
    return { claims: p + f, failed: f, first: (named ?? `${f} of ${p + f} failed`).trim() };
  }
  return { claims: 0, failed: 0, first: "" };
};

/**
 * Classify a completed mutation run.
 *
 * `code` is mutate.mjs's exit status: 2 means it refused (a bad anchor), and
 * anything else is the command's own. A command that fails WITHOUT producing a
 * claim has not caught anything — it has broken, and saying so is the whole
 * point of this file.
 */
export function verdict({ code, output }) {
  // EXIT 2 IS AMBIGUOUS, and assuming otherwise misclassified a real run.
  //
  // mutate.mjs's contract is "the exit code is the command's" — so 2 means its
  // own refusal ONLY when it also said so. A suite that exits 2 on failure
  // (e2e-wrangler.sh does) was being reported as an anchor that never matched,
  // which is the same "something did not run" lie this file exists to stop,
  // one level up. The message is the evidence; the code alone is not.
  const said = strip(output).split("\n").find((l) => l.startsWith("mutate:"));
  if (code === 2 && said) return { outcome: "anchor", detail: said, claims: 0, failed: 0 };
  const clean = strip(output);

  // A RUN THE SUITE ITSELF DISOWNED. The sweep hashes its sources before and
  // after; if they moved, the result is about no particular version of the code
  // and nothing may be concluded from it — least of all "the mutant survived".
  if (/NOT ATTRIBUTABLE/.test(clean)) {
    return { outcome: "unattributable", detail: "the tree changed while the run was in flight", claims: 0, failed: 0 };
  }

  // INCOMPLETE IS A CATCH, and missing it was a real interaction between two
  // things built two rounds apart. The suites now count their own claims, so a
  // mutation that makes one stop early trips that count instead of failing a
  // claim — no FAIL line, and this file called it "silent: the run broke rather
  // than catching anything". The suite had not broken. It had noticed that
  // claims went missing, which is exactly what it was given the count for.
  const short = /^.*\bINCOMPLETE\b.*$/m.exec(clean);
  if (short) return { outcome: "caught", detail: short[0].trim(), claims: countClaims(output).claims, failed: 1 };

  const { claims, failed, first } = countClaims(output);
  if (claims === 0) {
    // A RUNNER THAT MATCHED NOTHING, said so rather than left as a puzzle.
    //
    // "produced no claims" is the correct verdict and a useless one. It cost a
    // round: three mutations reported SILENT, the same mutations run singly were
    // CAUGHT, and I wrote that I could not explain it. The cause was zsh — it
    // does NOT word-split an unquoted `$S`, so three test paths arrived as one
    // argument and bun answered `Test filter "..." had no matches`. It had told
    // me; the verdict had not passed it on.
    const nothing = /Test filter .* had no matches|Tests need "\.test"|no test files found/i.exec(clean);
    if (nothing) {
      return { outcome: "silent", detail: `the runner matched no tests: ${nothing[0].slice(0, 120)}`, claims, failed };
    }
    // A SUITE THAT SKIPPED IS NOT A SUITE THAT PROVED NOTHING.
    //
    // It cost another round. Ten Docker entries reported SILENT and the summary
    // said NOT PROVEN, which reads as "these claims cannot fail" — the most
    // alarming thing this tool can say. The truth was that no celld node was
    // running, so every suite printed one SKIP line and exited 0. The suites
    // were right, the runner had the reason in its hands, and the verdict threw
    // it away exactly as the zsh case above did.
    //
    // Separated because the two demand opposite responses: a silent run is a
    // broken command to debug, a skipped one is a precondition to satisfy.
    const skip = /^\s*(?:SKIP|SKIPPED)\b[:.]?\s*(.*)$/mi.exec(clean);
    if (skip) {
      return { outcome: "skipped", detail: `the suite SKIPPED: ${(skip[1] || "no reason given").slice(0, 140)}`, claims, failed };
    }
    return { outcome: "silent", detail: `the command produced no claims (exit ${code})`, claims, failed };
  }
  if (code === 0 && failed === 0) return { outcome: "survived", detail: `${claims} claims ran, none failed`, claims, failed };
  if (failed === 0) return { outcome: "silent", detail: `exit ${code} but no claim failed — the run broke rather than catching anything`, claims, failed };
  return { outcome: "caught", detail: first, claims, failed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const argv = process.argv.slice(2);
  let out = "", code = 0;
  try {
    const r = await run(process.execPath, [`${HERE}mutate.mjs`, ...argv], { maxBuffer: 64 * 1024 * 1024 });
    out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    code = typeof e.code === "number" ? e.code : 1;
  }
  const v = verdict({ code, output: out });
  console.log(`${v.outcome.toUpperCase().padEnd(9)} ${v.detail}`);
  // Only `caught` is a good outcome for a mutant. `anchor` and `silent` are
  // tool failures, and exit 2 so a script cannot mistake either for a result.
  // caught is the only good outcome. survived is a finding. anchor, silent and
  // unattributable are tool or environment failures, and exit 2 so no script can
  // mistake one for a result.
  process.exit(v.outcome === "caught" ? 0 : v.outcome === "survived" ? 1 : 2);
}
