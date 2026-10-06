// THE IMAGE PIPELINE — generate the specs, then CHECK them against the builder
// that will actually run them.
//
// Platinum has no Dockerfile: a template image is a spec JSON applied by the
// platform's own builder (POST /v1/templates/from-spec). Two things then go
// wrong quietly:
//
//   1. `copy` carries file content inline as base64. Hand-paste it once and it
//      is stale the next time someone edits the source. So the daemon spec is
//      GENERATED from daemon/server.js, never written.
//
//   2. A spec that the builder rejects fails at deploy time, on a machine that
//      is not yours, after a template build has already started. The contract
//      is right there in apps/api/src/api/templates.ts — op names, the name
//      regex, cpu/ram/disk bounds — so it can be checked here instead.
//
// `npm run images` does both. It is the standardised way to produce an image
// for this thing, and it is the same shape as ../pt-celld.spec.json.
import { readFileSync, writeFileSync } from "node:fs";

// Mirrors the zod schema and the op list documented in
// apps/api/src/api/templates.ts. If the builder gains an op, add it here; if it
// tightens a bound, this is where the mismatch should surface.
const ALLOWED_OPS = new Set(["env", "workdir", "user", "run", "pip", "npm", "apt", "kernel_modules", "copy"]);
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BOUNDS = {
  default_cpu: [1, 16],
  default_ram_mb: [128, 32768],
  default_disk_gb: [1, 100],
};

export function validateSpec(spec, label) {
  const problems = [];
  if (!spec.base_image) problems.push("base_image is required");
  if (spec.name !== undefined) {
    if (!NAME_RE.test(spec.name)) problems.push(`name '${spec.name}' does not match ${NAME_RE}`);
    if (spec.name.length > 64) problems.push("name exceeds 64 characters");
  }
  for (const [i, step] of (spec.steps ?? []).entries()) {
    if (!ALLOWED_OPS.has(step.op)) problems.push(`steps[${i}] uses op '${step.op}', which the builder does not implement`);
    if (step.op === "copy") {
      if (!step.dst) problems.push(`steps[${i}] copy has no dst`);
      if (!step.content_b64) problems.push(`steps[${i}] copy has no content_b64`);
      // The route's own comment calls this "small inline files"; a large copy
      // belongs in a file upload, and finding that out at build time is worse.
      else if (step.content_b64.length > 512 * 1024) {
        problems.push(`steps[${i}] inlines ${(step.content_b64.length / 1024).toFixed(0)} KB — use a file upload instead`);
      }
    }
    if (step.op === "env" && (!step.key || step.value === undefined)) problems.push(`steps[${i}] env needs key and value`);
  }
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    const v = spec[k];
    if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) {
      problems.push(`${k}=${v} is outside the builder's ${lo}..${hi}`);
    }
  }
  return { label, problems };
}

function daemonSpec() {
  const daemon = readFileSync(new URL("./daemon/server.js", import.meta.url));
  const entry = [
    "#!/bin/sh",
    "# The workspace half of an agent cell: a shell and a filesystem behind",
    "# three POST routes. The cell has neither and calls in over HTTP.",
    "set -e",
    ': "${TOKEN:?TOKEN is required — this daemon runs commands}"',
    'mkdir -p "${WORK_ROOT:-/work}"',
    "# exec, so the daemon IS pid 1: if it dies the sandbox dies with it and",
    "# the platform can see that. The same mistake celld-boot.sh documents",
    "# (`tail -f /dev/null` outliving the thing it exists to run).",
    "exec node /opt/agent-daemon/server.js",
    "",
  ].join("\n");

  return {
    // Required by POST /v1/templates/from-spec. The celld spec next door omits
    // them because it is passed inline as the `image` of a sandbox create;
    // including them makes this usable both ways.
    name: "pt-agent-daemon",
    version: "0.1.0",
    base_image: "node:22-slim",
    steps: [
      { op: "apt", packages: ["ca-certificates", "curl", "git", "ripgrep", "procps"] },
      { op: "copy", dst: "/opt/agent-daemon/server.js", mode: "0644", content_b64: daemon.toString("base64") },
      { op: "copy", dst: "/usr/local/bin/agent-daemon", mode: "0755", content_b64: Buffer.from(entry).toString("base64") },
      { op: "env", key: "WORK_ROOT", value: "/work" },
      { op: "env", key: "PORT", value: "7070" },
    ],
    entrypoint: "/usr/local/bin/agent-daemon",
    default_cpu: 2,
    default_ram_mb: 2048,
    default_disk_gb: 20,
  };
}

// `import.meta.main` is a Bun/Deno thing; in Node it is undefined, so
// `?? true` made every IMPORT of this module regenerate and revalidate. Compare
// the module URL to argv[1] instead, which is correct on both.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const spec = daemonSpec();
  writeFileSync(new URL("./pt-agent-daemon.spec.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");

  // Both images are checked, not just the generated one: the celld spec is the
  // other half of this system and a change there breaks it just as completely.
  const celld = JSON.parse(readFileSync(new URL("../pt-celld.spec.json", import.meta.url), "utf8"));
  const results = [validateSpec(spec, "pt-agent-daemon.spec.json"), validateSpec(celld, "../pt-celld.spec.json")];

  let bad = 0;
  for (const r of results) {
    if (r.problems.length === 0) {
      console.log(`  ok    ${r.label}`);
    } else {
      bad++;
      console.log(`  FAIL  ${r.label}`);
      for (const p of r.problems) console.log(`          ${p}`);
    }
  }
  const inlined = spec.steps.filter((s) => s.op === "copy").reduce((n, s) => n + s.content_b64.length, 0);
  console.log(`  generated pt-agent-daemon.spec.json (${(inlined / 1024).toFixed(1)} KB inlined)`);
  if (bad) process.exit(1);
}
