// WHICH SUITES ACTUALLY EXERCISE WHICH SOURCE — AND A CHECK THAT THEY DO.
//
// Both auditors mutate a file and ask "did any claim notice?". The question is
// only meaningful if the suites they run can reach the file, and a map that is
// wrong about that manufactures findings: it reports covered code as untested,
// which sends someone to write claims for guards that already have them.
//
// This has gone wrong twice in this repo. A hand-written map here mapped
// execenv.js to three suites and left out cancel-logic, which is the only suite
// that drives its abort branches. The bindings auditor simply omitted r2-logic
// and reported forty of r2.js's conditions as survivors.
//
// So the mapping is DERIVED — follow the relative imports out of each suite —
// and where derivation cannot work it is declared AND VERIFIED.
//
// Derivation cannot work for two files: daemon/server.js and celldctl.mjs are
// exercised by SPAWNING them, not importing them, so no import graph reaches
// them from any suite. Falling back to "run everything" would be correct and
// far too slow. Declaring their suites brings back exactly the hazard above —
// unless the declaration is checked, which is what canaryFor is for.
import { readFileSync } from "node:fs";

const HERE = new URL("..", import.meta.url).pathname;

/** Every node suite test/all.sh runs. The shell suites need a live container. */
export const ALL_SUITES = [
  "tools-logic.mjs", "platinum-shapes.mjs", "compaction-logic.mjs", "daemon-safety.mjs", "cell-logic.mjs",
  "atob-shim.mjs", "model-logic.mjs", "celldctl-logic.mjs", "deploy-contract.mjs",
  "build-and-model.mjs", "execenv-logic.mjs", "daemon-persist.mjs", "opid-identity.mjs",
  "cancel-logic.mjs", "skills-logic.mjs", "ledger-parity.mjs", "archive-logic.mjs",
  "meter-logic.mjs", "execenv-platinum.mjs",
];

/** cell-logic needs node's SQLite; the rest run plain. */
export const nodeArgsFor = (suite) => (suite === "cell-logic.mjs" ? ["--experimental-sqlite"] : []);

// THERE IS NO HAND-WRITTEN MAP HERE, and there was, and it was wrong twice in
// the same commit that added it.
//
// It declared daemon/server.js -> [daemon-safety, daemon-persist], because no
// import reached it. Three other suites reach it perfectly well with
// `await import("../daemon/server.js")`; the scan only matched `from "..."`.
// Sixteen of that file's branches were reported as untested by suites that were
// simply never run.
//
// It declared celldctl.mjs -> [celldctl-logic, deploy-contract, build-and-model]
// on the strength of "deploy-contract spawns things". MEASURED, by breaking
// celldctl.mjs and running all eighteen suites: exactly one notices, and it is
// celldctl-logic. The other two were invented.
//
// Third time a typed map has been wrong in this repo. So derivation is the only
// source, `import(...)` included, and a file it cannot place falls back to
// running everything — slow, and never a lie.

/** Does `suite` reach `sourceFile` through relative imports, at any depth? */
function reaches(suite, sourceFile) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return false;
    seen.add(file);
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return false; }
    // The bundle contains every source, so importing it reaches all of them.
    if (/["']\.\.\/dist\/worker\.js["']/.test(text) && sourceFile.startsWith(`${HERE}src/`)) return true;
    // STATIC AND DYNAMIC. Matching only `from "..."` missed
    // `await import("../daemon/server.js")`, which is how three suites reach the
    // tool daemon — so derivation found nothing, a hand-written fallback with
    // two suites in it was used instead, and sixteen of that file's branches
    // were reported as untested when the suites that test them were simply not
    // run. The same shape of wrong answer this map exists to prevent.
    for (const m of text.matchAll(/(?:from\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const target = new URL(m[1], `file://${file}`).pathname;
      if (target === sourceFile) return true;
      if (walk(target)) return true;
    }
    return false;
  };
  return walk(`${HERE}test/${suite}`);
}

/** The suites that exercise `sourceFile`, or all of them when none can be placed. */
export function suitesFor(sourceFile) {
  const derived = ALL_SUITES.filter((s) => reaches(s, sourceFile));
  return derived.length ? derived : ALL_SUITES;
}

/**
 * A mutation so total that the chosen suites MUST notice it.
 *
 * If they do not, the mapping is wrong and every survivor this file produces is
 * noise. Prepending a throw at module scope breaks the file for an importer and
 * for a spawned process alike, so the same canary works for both kinds of
 * mapping — which is the point: the declared ones get the same check as the
 * derived ones rather than being taken on trust.
 */
export const canary = (src) => `throw new Error("audit canary");\n${src}`;
