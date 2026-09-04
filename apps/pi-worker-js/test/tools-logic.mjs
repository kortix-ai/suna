// THE TOOLS EVERY OTHER CLAIM RESTS ON.
//
// mutate.mjs decides whether a guard is covered, crash-reporter.mjs decides
// whether a crashing suite is reported as a failure, and js-mask.mjs decides
// which parts of a source the auditors are allowed to touch. Twenty-five suites
// import the second one. Every "0 survived" in this repo is a statement about
// the first.
//
// None of the three had a claim. That is the worst place for an untested tool:
// a bug in mutate.mjs does not fail anything, it makes everything pass — the
// anchor silently misses, the command runs against unmodified code, and "0
// failures" is read as "the guard is covered". Its own header says that has
// already produced three wrong conclusions here.
//
// So this file mutates a scratch file, not a source, and checks what the tool
// actually did to it.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=66

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commentMask, literalMask } from "../../tools/js-mask.mjs";
import { havePlatinum, platinumPath } from "./platinum-repo.mjs";
import { countClaims, verdict } from "../../tools/mutant.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

const run = promisify(execFile);
const HERE = new URL("..", import.meta.url).pathname;
const MUTATE = `${HERE}../tools/mutate.mjs`;

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

const box = mkdtempSync(join(tmpdir(), "tools-logic-"));
process.on("exit", () => rmSync(box, { recursive: true, force: true }));

/** Run mutate.mjs against a scratch file and report what happened to it. */
async function mutate({ content, from, to, cmd, build, line }) {
  const file = join(box, `f${Math.random().toString(36).slice(2)}.js`);
  const seen = join(box, "seen.txt");
  writeFileSync(file, content);
  rmSync(seen, { force: true });
  // The command records what the file looked like WHILE it ran, which is the
  // only way to tell "mutated then restored" from "never mutated".
  const args = ["--file", file, "--from", from, "--to", to,
    ...(line === undefined ? [] : ["--line", String(line)]),
    ...(build === undefined ? [] : ["--build", build]),
    "--", "sh", "-c", cmd ?? `cp ${file} ${seen}`];
  let code = 0, stderr = "";
  try { await run(process.execPath, [MUTATE, ...args]); }
  catch (e) { code = typeof e.code === "number" ? e.code : 1; stderr = String(e.stderr ?? ""); }
  let during = null;
  try { during = readFileSync(seen, "utf8"); } catch { /* the command never ran */ }
  return { code, stderr, during, after: readFileSync(file, "utf8"), ran: during !== null };
}

const SRC = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";

// ── the anchor is the whole point ───────────────────────────────────────────
// "The patch silently does nothing, the command runs against unmodified code,
// and '0 failures' is read as 'the guard is covered'." — mutate.mjs's own header.
{
  const missed = await mutate({ content: SRC, from: "const zzz = 9;", to: "x" });
  check("AN ANCHOR THAT DOES NOT MATCH DOES NOT RUN THE COMMAND",
    missed.ran === false, `command ran anyway: ${JSON.stringify(missed.during)}`);
  check("and it exits non-zero, so `mutate ... && echo` cannot read as success",
    missed.code !== 0, String(missed.code));
  check("saying which anchor was not found", /not found/.test(missed.stderr), missed.stderr.slice(0, 120));
  check("and the file is untouched", missed.after === SRC);

  const ambiguous = await mutate({ content: SRC, from: "const a", to: "const q" });
  check("an anchor matching TWICE is refused rather than applied to the first",
    ambiguous.ran === false && ambiguous.code !== 0, JSON.stringify({ ran: ambiguous.ran, code: ambiguous.code }));
  check("and says how many times it matched, and to use --line",
    /matches 2 times/.test(ambiguous.stderr) && /--line/.test(ambiguous.stderr), ambiguous.stderr.slice(0, 140));
  const disambiguated = await mutate({ content: SRC, from: "const a", to: "const q", line: 3 });
  check("--line disambiguates, and touches only that line",
    disambiguated.during === "const a = 1;\nconst b = 2;\nconst q2 = 1;\n", JSON.stringify(disambiguated.during));
  const wrongLine = await mutate({ content: SRC, from: "const a", to: "const q", line: 2 });
  check("while --line pointing at a line without the anchor is refused, not applied elsewhere",
    wrongLine.ran === false && wrongLine.code !== 0, JSON.stringify({ ran: wrongLine.ran, code: wrongLine.code }));
}

// ── mutated during, restored after ──────────────────────────────────────────
{
  const ok = await mutate({ content: SRC, from: "const b = 2;", to: "const b = 99;" });
  check("a matching anchor IS applied while the command runs",
    ok.during === "const a = 1;\nconst b = 99;\nconst a2 = 1;\n", JSON.stringify(ok.during));
  check("and the file is restored BYTE-IDENTICALLY afterwards",
    ok.after === SRC, JSON.stringify(ok.after));
  check("a command that succeeds exits 0", ok.code === 0, String(ok.code));

  const failing = await mutate({ content: SRC, from: "const b = 2;", to: "const b = 99;", cmd: "exit 3" });
  check("the exit code is the COMMAND's, which is what makes a mutant readable as caught",
    failing.code === 3, String(failing.code));
  check("and the file is restored even when the command failed", failing.after === SRC);

  const killed = await mutate({ content: SRC, from: "const b = 2;", to: "const b = 99;", cmd: "kill -TERM $$" });
  check("and even when the command is killed by a signal", killed.after === SRC, JSON.stringify(killed.after));
}

// ── --build, and the stale-bundle false negative ────────────────────────────
// "A MUTATED SOURCE THAT IS BUNDLED MUST BE REBUILT FIRST" — this cost a real
// finding: removing the agent's alarm re-arm strands four of five queued turns,
// and every mutation of it read as "0 claims failed" because dist/worker.js was
// never rebuilt.
{
  const built = await mutate({
    content: SRC, from: "const b = 2;", to: "const b = 99;",
    build: `cp ${join(box, "built-src")} ${join(box, "built-out")} 2>/dev/null || true`,
  });
  check("a build that succeeds still runs the command", built.ran === true);
  const broken = await mutate({
    content: SRC, from: "const b = 2;", to: "const b = 99;", build: "exit 1",
  });
  check("A BUILD THAT FAILS ABORTS, rather than testing stale output",
    broken.ran === false, `command ran against a failed build: ${JSON.stringify(broken.during)}`);
  check("and says so, rather than reporting the command's silence as a pass",
    broken.code !== 0 && /--build failed/.test(broken.stderr), broken.stderr.slice(0, 140));
  check("with the file restored anyway", broken.after === SRC);
}

// ── crash-reporter: a crash must read as a failure ──────────────────────────
// Four separate times a claim detected its mutation by THROWING rather than
// failing: node printed a stack trace and the run ended with no FAIL line, which
// the suite runner — which greps for FAIL — reads as a broken file rather than
// the regression it is.
{
  const script = join(box, "crasher.mjs");
  const runSuite = async (body) => {
    writeFileSync(script, `import { watchClaims } from "${HERE}../tools/crash-reporter.mjs";\n` +
      'const check = watchClaims((n, c) => console.log(c ? `  ok    ${n}` : `  FAIL  ${n}`));\n' + body);
    try { const r = await run(process.execPath, [script]); return { code: 0, out: r.stdout }; }
    catch (e) { return { code: e.code ?? 1, out: String(e.stdout ?? "") }; }
  };
  const crashed = await runSuite('check("the first claim", true);\nthrow new Error("boom");\n');
  check("an uncaught throw becomes a FAIL LINE, not a bare stack trace",
    /^\s*FAIL\s+the suite threw/m.test(crashed.out), crashed.out.slice(0, 160));
  check("naming the last claim that got through, so the reader knows where it stopped",
    /after "the first claim"/.test(crashed.out), crashed.out.slice(0, 200));
  check("and the process exits non-zero, so a runner notices", crashed.code !== 0, String(crashed.code));

  const rejected = await runSuite('check("one", true);\nawait Promise.reject(new Error("nope"));\n');
  check("an unhandled rejection is reported the same way",
    /FAIL\s+the suite (threw|rejected)/.test(rejected.out), rejected.out.slice(0, 160));

  // A throw while the claim is IN FLIGHT — inside the check itself, not while
  // its argument is being evaluated — is the case that needs the reporter to
  // remember which claim it was on. An alternation that accepts either wording
  // would pass without that memory, which is how a claim stops being one.
  writeFileSync(script, `import { watchClaims } from "${HERE}../tools/crash-reporter.mjs";\n` +
    'const check = watchClaims((n) => { if (n === "the one in flight") throw new Error("inside the check"); console.log(`  ok    ${n}`); });\n' +
    'check("an earlier claim", true);\ncheck("the one in flight", true);\n');
  let inFlight;
  try { inFlight = { out: (await run(process.execPath, [script])).stdout }; }
  catch (e) { inFlight = { out: String(e.stdout ?? "") }; }
  check("a throw while a claim is IN FLIGHT names THAT claim, not the one before it",
    /while checking "the one in flight"/.test(inFlight.out), inFlight.out.slice(0, 220));

  const clean = await runSuite('check("passes", true);\ncheck("fails", false);\n');
  check("and a suite that does not crash is passed through untouched",
    /ok    passes/.test(clean.out) && /FAIL  fails/.test(clean.out) && !/the suite threw/.test(clean.out),
    clean.out.slice(0, 160));
}

// ── js-mask: literalMask, which also masks strings, templates and regexes ───
// OVER-masking is the dangerous direction here too, and more likely: a regex
// misread as division swallows everything to the next slash, and the auditor
// built on this then reports "0 survived" over code it never examined.
{
  const at = (src, needle) => {
    const m = literalMask(src);
    const i = src.indexOf(needle);
    return i === -1 ? null : Boolean(m[i]);
  };
  // The exact construct js-mask's own comment names as the reason it did not
  // try: a regex holding both a double and a single quote.
  const HARD = `const re = /^([\\w-]+)(?:([~^$*|]?=)"?'?([^"']*)"?'?)?$/;\nif (a >= b) x();\n`;
  check("a regex holding both quote characters is masked", at(HARD, "[~^$*|]") === true);
  check("AND THE CODE AFTER IT IS NOT — the failure that would silently shrink an audit",
    at(HARD, ">=") === false);
  check("a division is not mistaken for a regex", at("const r = a / b; const c = 1 > 0;", ">") === false);
  check("a regex after a return is a regex, not a division", at("return /a>b/.test(s);", "a>b") === true);
  check("a string is masked", at('const s = "a > b";', "a > b") === true);
  check("a template literal's text is masked", at("const s = `a > b`;", "a > b") === true);
  check("but its ${} substitution is code again",
    at("const s = `x${ a > b }y`;", "a > b") === false);
  check("a nested template inside a substitution still closes correctly",
    at("const s = `a${ `b${ c }d` }e`; const t = 1 > 0;", "1 > 0") === false);
  check("a character class containing a slash does not end the regex early",
    at("const r = /[/]>/; const t = 2 > 1;", "2 > 1") === false);
  check("an escaped quote does not end a string early",
    at('const s = "a\\"b > c"; const t = 3 > 2;', "3 > 2") === false);
  check("comments are masked by literalMask too, so it is a superset of commentMask",
    at("// x > y\n", "x > y") === true);
}

// ── js-mask: mask comments, and nothing else ────────────────────────────────
// Under-masking gives a false finding (prose reported as an untested guard).
// OVER-masking is worse: the auditor silently skips real code and still prints
// "0 survived".
{
  const masked = (src, needle) => {
    const m = commentMask(src);
    const i = src.indexOf(needle);
    return i === -1 ? null : Boolean(m[i]);
  };
  check("a line comment is masked", masked("// if (x) y;\n", "if (x)") === true);
  check("a block comment is masked", masked("/* if (x) y; */\n", "if (x)") === true);
  check("an unterminated block comment masks to the end of the file",
    masked("code;\n/* if (x)\nmore\n", "if (x)") === true);
  check("REAL CODE IS NOT MASKED", masked("if (x) y;\n", "if (x)") === false);
  check("code after a line comment ends is not masked",
    masked("// note\nif (x) y;\n", "if (x)") === false);
  check("code after a block comment closes is not masked",
    masked("/* note */ if (x) y;\n", "if (x)") === false);
  check("a division is not mistaken for a comment", masked("const r = a / b; if (x) y;\n", "if (x)") === false);

  // The regression that matters: over-masking on the real sources would make
  // both auditors quietly audit less while still reporting success. Exactly one
  // conditional in this repo lives inside a comment — r2.js's header explains
  // the null contract with `if (!o)` in it — and that number is the guard.
  const sources = [];
  // Without a Platinum checkout only this package's sources are scanned — the
  // one commented conditional lives in Platinum's r2.js, so the guard is 0 then.
  const dirs = [`${HERE}src`, ...(havePlatinum ? [platinumPath("infra/celld/bindings")] : [])];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) if (f.endsWith(".js")) sources.push(join(dir, f));
  }
  let inComment = 0, total = 0;
  const where = [];
  for (const f of sources) {
    const src = readFileSync(f, "utf8");
    const m = commentMask(src);
    for (const hit of src.matchAll(/(^|[\s;{}])if\s*\(/g)) {
      total++;
      if (m[hit.index]) { inComment++; where.push(`${f.split("/").pop()}:${src.slice(0, hit.index).split("\n").length}`); }
    }
  }
  check(havePlatinum
    ? `exactly one conditional across all ${sources.length} sources is inside a comment, and it is r2.js's`
    : `no conditional across this package's ${sources.length} sources is inside a comment (no Platinum checkout: r2.js not scanned)`,
    havePlatinum ? inComment === 1 && where[0]?.startsWith("r2.js:") : inComment === 0, `${inComment} masked: ${where.join(", ")}`);
  // Measured: 115 in this package alone, several hundred with Platinum's bindings.
  check(`and the other ${havePlatinum ? "several hundred" : "hundred-odd"} are code the auditors will still mutate`,
    total - inComment > (havePlatinum ? 200 : 100), `${total - inComment} auditable conditionals`);
}

// ── the verdict on a mutant, which I got wrong four times by hand ───────────
// Every one of those was a throwaway wrapper around mutate.mjs, and every one
// reported something false in the same direction: something did not run, and
// the silence was read as a result. The classification is a function now, and
// these are the four shapes it exists to tell apart — including the two that a
// hand-rolled wrapper collapses into "pass".
{
  const E = String.fromCharCode(27);
  const colour = (t) => `${E}[32m${t}${E}[0m`;

  const caught = verdict({ code: 1, output: "  ok    one\n  FAIL  two\n\n  1 failure(s)\n" });
  check("a run where a claim failed is CAUGHT, and names the claim",
    caught.outcome === "caught" && /two/.test(caught.detail), JSON.stringify(caught));

  const survived = verdict({ code: 0, output: "  ok    one\n  ok    two\n" });
  check("a run where every claim passed is SURVIVED, with the count",
    survived.outcome === "survived" && survived.claims === 2, JSON.stringify(survived));

  // 1. The anchor that never matched, which I reported as SURVIVED.
  const anchor = verdict({ code: 2, output: "mutate: --from not found in x.js: nope\n" });
  check("an anchor that did not match is ANCHOR, not survived — the suite never ran",
    anchor.outcome === "anchor" && /not found/.test(anchor.detail), JSON.stringify(anchor));

  // 2. The missing argument, so the command was a directory. Non-zero exit, no
  //    claims — which I reported as "caught -> 0 claims".
  const broken = verdict({ code: 1, output: "Error: Cannot find module '/x/test/'\n" });
  check("a command that failed WITHOUT producing a claim is SILENT, never caught",
    broken.outcome === "silent", JSON.stringify(broken));

  // 3. And the same shape with a zero exit — the one that looks most like a pass.
  // pytest reports a tally too, one word longer than bun's. The Python SDK's
  // list() mutation was called SILENT while pytest was printing "1 failed" —
  // the claim had done its job and the verdict could not read the runner.
  const pyCaught = verdict({ code: 1, output: "FAILED tests/test_unit.py::test_list_runtime_filter_reaches_the_query_string\n1 failed, 105 deselected in 0.06s\n" });
  check("a pytest tally with a failure is CAUGHT, naming the FAILED test",
    pyCaught.outcome === "caught" && /test_list_runtime_filter/.test(pyCaught.detail), JSON.stringify(pyCaught));
  const pyGreen = verdict({ code: 0, output: "..\n2 passed, 104 deselected in 0.15s\n" });
  check("and a pytest tally with no failure is SURVIVED, not silent",
    pyGreen.outcome === "survived" && pyGreen.claims === 2, JSON.stringify(pyGreen));
  const quiet = verdict({ code: 0, output: "v22.15.0\n" });
  check("a command that produced no claims at all is SILENT even when it exits 0",
    quiet.outcome === "silent" && quiet.claims === 0, JSON.stringify(quiet));

  // The case none of my four wrappers even had a branch for: claims RAN and all
  // of them passed, and the process still exited non-zero — a suite that threw
  // in teardown, or a runner that failed after the last claim. Calling that
  // "caught" would credit the mutant with a failure that never happened.
  const brokeAfter = verdict({ code: 1, output: "  ok    one\n  ok    two\n" });
  check("a run whose claims all PASSED but which exited non-zero is SILENT, not caught",
    brokeAfter.outcome === "silent" && brokeAfter.claims === 2, JSON.stringify(brokeAfter));

  // EXIT 2 IS THE COMMAND'S TOO. mutate.mjs passes the command's status through,
  // and e2e-wrangler.sh exits 2 on failure — so reading 2 as "the anchor never
  // matched" reported a caught mutant as a tool failure. The message is the
  // evidence, not the number.
  const two = verdict({ code: 2, output: "  ok    one\n  FAIL  the suite noticed\n" });
  check("an exit of 2 WITH claims is judged by the claims, not called an anchor failure",
    two.outcome === "caught" && /the suite noticed/.test(two.detail), JSON.stringify(two));
  const refused = verdict({ code: 2, output: "mutate: --from not found in x.js: nope\n" });
  check("while an exit of 2 that mutate.mjs explains IS an anchor failure",
    refused.outcome === "anchor", JSON.stringify(refused));

  // TWO THINGS BUILT TWO ROUNDS APART, and the interaction between them.
  //
  // The suites count their own claims now, so a mutation that makes one stop
  // early trips that count instead of failing a claim — INCOMPLETE, and no FAIL
  // line anywhere. This file called that "silent: the run broke rather than
  // catching anything". The suite had not broken. It had noticed that claims
  // went missing, which is precisely what the count is for, and calling it
  // silent would have read as "no coverage here" for a guard that has it.
  const short = verdict({ code: 1, output: `  ${colour("PASS")} one\n  ${colour("INCOMPLETE")} 2 claims ran, expected 7\n` });
  check("a suite that stops early is CAUGHT — the missing claims are the failure",
    short.outcome === "caught" && /expected 7/.test(short.detail), JSON.stringify(short));
  const viaRunner = verdict({ code: 1, output: "  crash  INCOMPLETE: 2 of 7 claims ran\n\n  1 suite(s) failed\n" });
  check("and so is the same thing reported by all.sh rather than by the suite",
    viaRunner.outcome === "caught" && /2 of 7/.test(viaRunner.detail), JSON.stringify(viaRunner));

  // The other new signal, which must NOT be read as a result either way.
  const moved = verdict({ code: 1, output: "  ok    a claim\n\n  NOT ATTRIBUTABLE the sources or suites changed while this ran\n" });
  check("a run whose tree changed underneath it is UNATTRIBUTABLE, not survived and not caught",
    moved.outcome === "unattributable", JSON.stringify(moved));

  // A RUNNER THAT REPORTS A TALLY INSTEAD OF LINES.
  //
  // bun prints "34 pass / 0 fail" and no per-test line, so this tool called a
  // real result "silent: produced no claims" and refused to judge it. Right
  // answer for a command that produced nothing; wrong for one that produced a
  // summary — and it meant the billing rails in apps/api, which are what stop
  // the standing request-counting gap being closed by accident, could not be
  // checked at all.
  const bunGreen = verdict({ code: 0, output: "bun test v1.3.9\n\n 34 pass\n 0 fail\n 122 expect() calls\n" });
  check("a runner that reports a tally is read, not called silent",
    bunGreen.outcome === "survived" && bunGreen.claims === 34, JSON.stringify(bunGreen));
  const bunRed = verdict({ code: 1, output: "bun test v1.3.9\n\nerror: expect(received).toEqual(expected)\n\n 33 pass\n 1 fail\n" });
  check("and a failing tally is CAUGHT, with the runner's own first line",
    bunRed.outcome === "caught" && bunRed.failed === 1 && /toEqual/.test(bunRed.detail), JSON.stringify(bunRed));
  check("per-claim lines still win when a suite prints them",
    verdict({ code: 0, output: "  ok    one\n\n 99 pass\n 0 fail\n" }).claims === 1);

  // A RUNNER THAT MATCHED NOTHING. "Produced no claims" is the correct verdict
  // and a useless one — it cost a round. Three mutations reported SILENT, the
  // same mutations run singly were CAUGHT, and I wrote that I could not explain
  // it. The cause was the shell: zsh does NOT word-split an unquoted `$S`, so
  // three test paths arrived as ONE argument and bun answered `Test filter
  // "..." had no matches`. bun had said so; the verdict had not passed it on.
  const noMatch = verdict({ code: 1, output: 'bun test v1.3.9\nTest filter "./a ./b" had no matches in --cwd="/x"\n' });
  check("a runner that matched no tests says THAT, not merely that nothing was claimed",
    noMatch.outcome === "silent" && /matched no tests/.test(noMatch.detail), JSON.stringify(noMatch));
  check("and it still exits as a tool failure rather than a result",
    noMatch.outcome !== "caught" && noMatch.outcome !== "survived");
  const genuinelyQuiet = verdict({ code: 1, output: "some other failure\n" });
  check("while an ordinary silent run keeps the general message",
    /produced no claims/.test(genuinelyQuiet.detail), JSON.stringify(genuinelyQuiet));

  // 4. The colour codes. A counter that does not strip them sees no claims,
  //    which lands back on SILENT and reads as "proved nothing".
  const coloured = verdict({ code: 1, output: `  ${colour("FAIL")}  a coloured claim\n` });
  check("ANSI colour does not hide a claim — this is what made seven claims read as none",
    coloured.outcome === "caught" && /a coloured claim/.test(coloured.detail), JSON.stringify(coloured));

  // Both packages' styles, since the bindings print `ok` and the shell suites
  // print `PASS`.
  const styles = countClaims("  ok    node style\n  PASS  shell style\n  FAIL  shell failure\n");
  check("claims are counted in both the node and shell styles",
    styles.claims === 3 && styles.failed === 1, JSON.stringify(styles));
  check("and prose that merely contains the word is not a claim",
    countClaims("this line says FAIL in the middle\nok, done\n").claims === 0,
    JSON.stringify(countClaims("this line says FAIL in the middle\nok, done\n")));
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the tools the other claims rest on: ${claims} claims`);
process.exit(bad ? 1 : 0);
