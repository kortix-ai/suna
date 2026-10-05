// pi-durable's OWN conformance suites, run against the cell's two adapters.
//
// The cell implements two pi contracts by hand: `ExecutionEnv` over its
// just-bash tree (src/execenv.cell.js) and `SqliteDatabase` over the Durable
// Object's SQLite (src/do-sqlite.js). pi ships the cases every implementation
// must pass (`@earendil-works/pi-durable/testing`), so the claim "the cell
// speaks pi's contract" is pi's assertion, not one written here to agree with
// the code.
//
// Cases a virtual shell cannot honour are listed in KNOWN_GAPS with the reason;
// a case that starts passing must be removed from the list (the run fails).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createEnvConformance, createStorageConformance } from "@earendil-works/pi-durable/testing";
import { cellExecutionEnv, cellFs } from "../src/execenv.cell.js";
import { openPiStorage } from "../src/do-sqlite.js";
import { makeStorage } from "./cell-harness.mjs";

const assertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (a, b) => assert.strictEqual(a, b),
  deepEqual: (a, b) => assert.deepStrictEqual(a, b),
  partialDeepEqual: (a, b) => assert.partialDeepStrictEqual(a, b),
  greaterThan: (a, b) => assert.ok(a > b, `${a} > ${b}`),
  rejects: async (p, includes) => {
    await assert.rejects(p, (e) => String(e?.message ?? e).includes(includes));
  },
};

/** Cases the cell's env does not pass, and why. Keep it honest: re-check on every just-bash or pi upgrade. */
const KNOWN_GAPS = new Map([
  // Filled from the first run; see the run output.
]);

let fresh = 0;
async function withEnv(use) {
  const db = new DatabaseSync(":memory:");
  const { sql } = makeStorage(db);
  const cell = cellFs(sql);
  await cell.ready;
  const dir = `/workspace/case-${++fresh}`;
  await cell.fs.mkdir(dir, { recursive: true });
  try {
    await use(cellExecutionEnv(cell, dir));
  } finally {
    db.close();
  }
}

async function withStorage(use) {
  const db = new DatabaseSync(":memory:");
  const storage = await openPiStorage(makeStorage(db));
  try {
    await use(storage);
  } finally {
    await storage.close?.();
    db.close();
  }
}

async function runCases(label, cases) {
  const results = { pass: [], fail: [], gapStillFails: [], gapNowPasses: [] };
  for (const c of cases) {
    let error = null;
    try {
      await Promise.race([
        c.run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${c.timeoutMs ?? 20_000} ms`)), c.timeoutMs ?? 20_000)),
      ]);
    } catch (e) {
      error = e;
    }
    const gap = KNOWN_GAPS.get(`${label}: ${c.name}`);
    if (gap && error) results.gapStillFails.push(c.name);
    else if (gap && !error) results.gapNowPasses.push(c.name);
    else if (error) results.fail.push(`${c.name}\n      ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n      ").slice(0, 900)}`);
    else results.pass.push(c.name);
  }
  console.log(`== ${label}: ${results.pass.length} pass, ${results.fail.length} fail, ${results.gapStillFails.length} known gaps`);
  for (const f of results.fail) console.log(`  FAIL ${f}`);
  for (const g of results.gapNowPasses) console.log(`  FIXED (remove from KNOWN_GAPS) ${g}`);
  return results.fail.length + results.gapNowPasses.length;
}

const failures =
  (await runCases("storage", createStorageConformance({ assertions, withStorage }))) +
  (await runCases("env", createEnvConformance({ assertions, withEnv, shell: ["sh", "-c"], symlinks: true })));

process.exitCode = failures ? 1 : 0;
