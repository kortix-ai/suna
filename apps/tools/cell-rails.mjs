#!/usr/bin/env node
// THE CONTROL-PLANE GATES THAT KEEP THIS RUNTIME WHERE IT BELONGS.
//
// celld's own suites prove the cell works. They say nothing about the rails in
// apps/api that decide whether one may be created at all, where it may land, and
// what it may be billed for — and those rails are what stand between "the cell
// runtime is registered" and "an unproven runtime is booting on customer hosts".
//
// Each is written down in a comment that explains itself well. That is not the
// same as holding. So each is crossed here, and the suite that ought to notice
// has to notice:
//
//   the operator flag defaults OFF, and an admin is not exempt
//   a PLANNED runtime is registered but never bootable
//   a cell lands on no host that has not advertised an isolate runner
//   an unregistered runtime lands nowhere at all
//   a cell is tenant-exclusive, because a v8 escape reads the neighbour
//   a cell declares v8-isolate isolation, weaker than the hypervisor
//   a cell manages its own storage, so the CP does not size a disk for it
//   scale-to-zero and backup-eligibility are DERIVED from what a runtime
//     declares, never from a hand-written list
//   and the refusals the API actually returns: no exec on a runtime with no
//     shell, no GPU on one with no GPU path, no inline image on one that
//     cannot build it — each refused BEFORE the platform does the work
//
// Run from the repo root: node infra/celld/tools/cell-rails.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verdict } from "./mutant.mjs";

const run = promisify(execFile);
const ROOT = new URL("../../..", import.meta.url).pathname;
const SUITES = [
  "./apps/api/src/runtimes.test.ts",
  "./apps/api/src/runnerKindGate.test.ts",
  "./apps/api/src/runtimeGate.test.ts",
  "./apps/api/src/cellStorage.test.ts",
  "./apps/api/src/runtimeGate.routing.test.ts",
];

const RAILS = [
  { rail: "the operator flag defaults OFF", expect: /OFF by default/, file: "apps/api/src/config.ts",
    from: "'flags.cell_runtime_enabled': { type: 'boolean', default: false,",
    to: "'flags.cell_runtime_enabled': { type: 'boolean', default: true," },
  { rail: "a planned runtime is never bootable", expect: /PLANNED|bootability/, file: "apps/api/src/runtimes.ts",
    from: "export const runtimeAvailable = (k: string): boolean => RUNTIMES[k]?.status === 'available';",
    to: "export const runtimeAvailable = (k: string): boolean => knownRuntime(k);" },
  { rail: "no host runs an isolate until it says so", expect: /microVM-everywhere|lands on no host/, file: "apps/api/src/runtimes.ts",
    from: "export const DEFAULT_RUNNER_KINDS: ReadonlyArray<RunnerKind> = ['microvm'];",
    to: "export const DEFAULT_RUNNER_KINDS: ReadonlyArray<RunnerKind> = ['microvm', 'isolate'];" },
  { rail: "an unregistered runtime lands nowhere", expect: /unknown runtime belongs on no host/, file: "apps/api/src/scheduler.ts",
    from: "  if (!kind) return sql`false`;", to: "  if (!kind) return sql`true`;" },
  { rail: "a cell is tenant-exclusive", expect: /EXCLUSIVE/, file: "apps/api/src/runtimes.ts",
    from: "RUNTIMES[runtimeKey]?.tenantBoundary === 'runner';", to: "false;" },
  { rail: "a cell declares the weaker isolation it has", expect: /weaker than the microVM boundary/, file: "apps/api/src/runtimes.ts",
    from: "    isolation: 'v8-isolate',", to: "    isolation: 'microvm'," },
  { rail: "a cell manages its own storage", expect: /terminated, because LTX/, file: "apps/api/src/runtimes.ts",
    from: "RUNTIMES[runtimeKey]?.statePersistence === 'replicated';", to: "false;" },
  { rail: "backup eligibility is derived from snapshot", expect: /BACKUP_ELIGIBLE_RUNTIMES/, file: "apps/api/src/runtimes.ts",
    from: "Object.values(RUNTIMES).filter(r => r.capabilities.snapshot).map(r => r.key);",
    to: "Object.values(RUNTIMES).map(r => r.key);" },
  { rail: "scale-to-zero is derived from persistence", expect: /scale-to-zero is derived/, file: "apps/api/src/runtimes.ts",
    from: "Object.values(RUNTIMES).filter(r => r.statePersistence === 'replicated').map(r => r.key);",
    to: "Object.values(RUNTIMES).map(r => r.key);" },
  { rail: "no runtime claims a billed unit nothing meters", expect: /billed unit the platform cannot meter|BILLED as a microVM/, file: "apps/api/src/runtimes.ts",
    line: 247,
    from: "billed: ['cpu', 'ram', 'storage'] },", to: "billed: ['cpu', 'ram', 'requests'] }," },
  { rail: "billing stays runtime-blind", expect: /FENCE/, file: "apps/api/src/billing.ts",
    from: "export async function emitCreate(",
    to: "export function billedFor(runtime) { return runtime; }\nexport async function emitCreate(" },

  // THE LAYER A CUSTOMER ACTUALLY MEETS. Everything above is the registry; these
  // are the refusals the API returns. A registry entry that other code is meant
  // to branch on, which nothing branches on, is the failure both halves exist to
  // prevent — and it has already happened here twice, with gpu and customImage.
  { rail: "a capability refusal is actually returned", expect: /refused exactly what it does not declare/, file: "apps/api/src/runtimeGate.ts",
    from: "  if (def.capabilities[gate.cap]) return null;", to: "  return null;" },
  { rail: "the refusal reads the path it was given", expect: /refused exactly what it does not declare/, file: "apps/api/src/runtimeGate.ts",
    from: "  const gate = requiredCapability(path);", to: '  const gate = requiredCapability("/nothing");' },
  { rail: "an unknown runtime does not slip past the gate", expect: /refused exactly what it does not declare/, file: "apps/api/src/runtimeGate.ts",
    from: "  const def = RUNTIMES[runtime];\n  if (!def) return null;",
    to: "  const def = RUNTIMES[runtime];\n  if (true) return null;" },
  { rail: "no GPU is attached to a runtime with no GPU path", expect: /GPU it has no path to/, file: "apps/api/src/runtimeGate.ts",
    from: "'gpu'", to: "'pauseResume'" },
  { rail: "an inline image is refused before the build runs", expect: /inline image BEFORE the build/, file: "apps/api/src/runtimeGate.ts",
    from: "'customImage'", to: "'pauseResume'" },
];

const bad = [];
for (const r of RAILS) {
  process.stdout.write(`  ${r.rail.padEnd(48)} `);
  let out = "", code = 0;
  try {
    const args = [`${ROOT}infra/celld/tools/mutate.mjs`, "--file", r.file, "--from", r.from, "--to", r.to,
      ...(r.line ? ["--line", String(r.line)] : []), "--", "bun", "test", ...SUITES];
    const x = await run(process.execPath, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    out = `${x.stdout ?? ""}${x.stderr ?? ""}`;
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    code = typeof e.code === "number" ? e.code : 1;
  }
  const v = verdict({ code, output: out });
  // WHICH test failed, not merely that one did.
  //
  // "Caught" only means something broke. A mutation that fails to compile, or
  // that trips an unrelated assertion, reports exactly the same word — and then
  // the rail it names has been proved by nothing. Each entry says which test
  // ought to notice it, and a catch by anything else is NOT a proof.
  const named = out.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
    .split("\n").filter((l) => /^\(fail\)/.test(l)).map((l) => l.replace(/^\(fail\)\s*/, "").trim());
  const right = v.outcome === "caught" && named.some((n) => r.expect.test(n));
  const label = right ? "CAUGHT" : v.outcome === "caught" ? "WRONG-TEST" : v.outcome.toUpperCase();
  console.log(`${label.padEnd(11)} ${named[0] ?? v.detail}`);
  if (!right) bad.push({ ...r, v, named });
}

console.log("");
if (bad.length === 0) console.log(`  all ${RAILS.length} control-plane rails hold when crossed.`);
else {
  console.log("  NOT PROVEN — crossing these broke no test:\n");
  for (const b of bad) {
    const why = b.v.outcome !== "caught"
      ? `${b.v.outcome}: ${b.v.detail}`
      : `something broke, but not the test this rail is about.\n      expected a failure matching ${b.expect}\n      got: ${(b.named ?? []).join(" | ") || "no named failure"}`;
    console.log(`    ${b.rail}\n      ${why}`);
  }
}
process.exit(bad.length ? 1 : 0);
