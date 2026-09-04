
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=6

import { watchClaims } from "../../tools/crash-reporter.mjs";// THE BASE64 PADDING SHIM, AGAINST A STRICT atob.
//
// Found by test/mutate-conditions.mjs: disabling any of the shim's three
// branches broke no claim. It exists because of a real bug — celld's atob is
// STRICT where node's is not, and a JWT segment needing exactly two characters
// of padding failed with "Failed to extract accountId from token", an error
// that says nothing about base64. A silent regression breaks deployment and
// points somewhere else entirely.
//
// THE FIRST VERSION OF THIS TEST WAS HOLLOW, and the mutation showed it: run
// under node, `globalThis.atob` is already lenient, so unpadded input decodes
// whether the shim is installed or not. The claims passed with the shim
// disabled.
//
// So the strict implementation is installed FIRST, in a fresh process, and the
// bundle is imported over it — which is the arrangement inside celld.
const strict = (input) => {
  const s = String(input);
  if (s.length % 4 !== 0) throw new TypeError("Invalid character");   // celld's behaviour
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new TypeError("Invalid character");
  return Buffer.from(s, "base64").toString("binary");
};
globalThis.atob = strict;

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const dec = (b) => { try { return globalThis.atob(b); } catch (e) { return `THREW ${e.message}`; } };

// Before the bundle: the strict implementation refuses what celld refused.
check("the strict atob refuses unpadded input, as celld's does", /THREW/.test(dec("aA")), dec("aA"));

// Importing the worker installs the shim over it.
await import("../dist/worker.js");

check("after the bundle loads, input needing TWO pad characters decodes — the case that broke celld auth",
  dec("aA") === "h", dec("aA"));
check("and input needing ONE pad character decodes", dec("aGk") === "hi", dec("aGk"));
check("already-padded input still decodes", dec("aGk=") === "hi" && dec("aA==") === "h");
check("base64url's - and _ are accepted, which is what a JWT actually uses",
  dec("_w") === "\xff", JSON.stringify(dec("_w")));
check("a genuinely malformed length is still refused rather than padded into nonsense",
  /THREW/.test(dec("a")), dec("a"));

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the padding shim survives a strict atob: ${claims} claims`);
process.exit(bad ? 1 : 0);
