#!/usr/bin/env node
// PRUNE THE CELLS THE TEST SUITES LEAVE BEHIND.
//
// Every suite makes its own cell — e2e-$$, stream-$$, crash-$$, evict-$RANDOM —
// and none of them removes it. That is deliberate and correct for isolation: a
// fixed name is what let a mutant poison the bindings fixture and break the two
// runs after it. The cost is that nothing ever cleans up.
//
// Measured on this machine, 2026-09-04: 275 MiB, 46,853 objects, 5,888 distinct
// cell scopes under the local dev bucket. Not dangerous, and not nothing —
// every sweep adds a few dozen more, and celld enumerates prefixes.
//
// Only `cells/` under the org prefix is removed. `deploy/` holds the
// DEPLOYMENTS — the bundle every node loads at startup — and taking those out
// would leave the node with nothing to serve.
//
// NOT wired into all.sh, deliberately. Deleting storage on a suite's exit is
// how one run destroys a cell another run is using, which is the same hazard
// that made celldctl-logic take a lock on wrangler.json. This is a command an
// operator runs, and it says what it removed.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const CFG = JSON.parse(readFileSync(new URL("./agent.config.json", import.meta.url), "utf8"));
const target = CFG.targets.local;
const base = target.bucket.replace(/^s3:\/\//, "");
const endpoint = target.endpoint.replace("host.docker.internal", "127.0.0.1");

const mc = async (cmd) => {
  const r = await run("docker", ["run", "--rm", "--network", "host", "--entrypoint", "sh", "quay.io/minio/mc", "-c",
    `mc alias set m ${endpoint} ${target.credentials.access_key} ${target.credentials.secret_key} >/dev/null 2>&1; ${cmd}`,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return (r.stdout ?? "").trim();
};

const before = await mc(`mc du m/${base}/cells 2>/dev/null || true`);
console.log(`  before  ${before || "(nothing)"}`);
if (process.argv.includes("--dry-run")) {
  console.log("  --dry-run: nothing removed");
  process.exit(0);
}
await mc(`mc rm --recursive --force m/${base}/cells >/dev/null 2>&1; true`);
const after = await mc(`mc du m/${base}/cells 2>/dev/null || true`);
const deploy = await mc(`mc ls m/${base}/deploy 2>/dev/null | wc -l`);
console.log(`  after   ${after || "(nothing)"}`);
console.log(`  deployments left intact: ${deploy.trim()}`);
