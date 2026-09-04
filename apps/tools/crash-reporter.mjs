// A SUITE THAT CRASHES MUST STILL SAY SO IN ITS OWN LANGUAGE.
//
// Four separate times in this session a claim detected its mutation by throwing
// rather than failing: the setup for the claim itself raised, node printed a
// stack trace, and the run ended with no FAIL line at all. To anyone reading the
// summary — including the suite runner, which greps for FAIL — that looks like a
// broken test file rather than the regression it actually is.
//
// Importing this converts an uncaught throw or rejection into a FAIL line that
// names the last claim that passed, so the reader knows where it got to. It does
// not replace catching a throw in the claim that expects one; it is the backstop
// for the ones nobody thought would throw.
//
//   import { watchClaims } from "../../tools/crash-reporter.mjs";
//   const check = watchClaims((name, cond, detail) => { ... });
let lastPassed = null;
let lastAttempted = null;

const report = (kind) => (err) => {
  const where = lastAttempted
    ? `while checking "${lastAttempted}"`
    : lastPassed ? `after "${lastPassed}"` : "before the first claim";
  console.log(`  FAIL  the suite ${kind} ${where}\n          ${String(err?.stack ?? err?.message ?? err).split("\n").slice(0, 3).join("\n          ")}`);
  process.exit(1);
};
process.on("uncaughtException", report("threw"));
process.on("unhandledRejection", report("rejected"));

/**
 * Wrap a suite's own `check` so the reporter knows how far it got.
 * The wrapped function behaves exactly like the one passed in.
 */
export function watchClaims(check) {
  return (name, cond, detail) => {
    lastAttempted = name;
    const r = check(name, cond, detail);
    if (cond) lastPassed = name;
    lastAttempted = null;
    return r;
  };
}
