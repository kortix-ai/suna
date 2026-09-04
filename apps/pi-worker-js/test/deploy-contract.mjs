// WHAT deploy.sh ACTUALLY SENDS TO PLATINUM.
//
// deploy.sh is the bridge to production and had never been executed once — celld
// is on no deployed environment, so there was nothing to point it at. A deploy
// path nobody has run is a design document with a shebang, and this one had a
// real bug in it: it reached step 4, having built a template and created TWO
// sandboxes, before dying on `celld: command not found` and leaving both behind.
//
// So: a stub control plane implementing the routes as apps/api defines them, a
// stubbed CELLD_BIN, and assertions on what was SENT. No Docker, no celld, no
// bucket — this is an HTTP contract and it can be checked like one.
//
// What it cannot check: that Platinum accepts the spec, that the cell boots,
// that celld reaches the bucket through the host gateway. Those need an
// environment with the cell runtime on it, and saying so is the point.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=15

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, copyFileSync } from "node:fs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const LOG = "/tmp/deploy-contract-calls.json";
const PORT = 7094;

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

const wrangler = `${HERE}../wrangler.json`;
const backup = `${HERE}../wrangler.json.deploybak`;
copyFileSync(wrangler, backup);
const restore = () => { try { copyFileSync(backup, wrangler); unlinkSync(backup); } catch {} };
process.on("exit", restore);

if (existsSync(LOG)) unlinkSync(LOG);
const cp = spawn(process.execPath, [`${HERE}cp-stub.mjs`], {
  env: { ...process.env, PORT: String(PORT), PT_TOKEN: "cp-stub-token", CALL_LOG: LOG },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 400));

const runDeploy = (extraEnv = {}) => new Promise((resolve) => {
  const p = spawn("./deploy.sh", [], {
    cwd: `${HERE}..`,
    env: {
      ...process.env,
      PT_API_URL: `http://127.0.0.1:${PORT}`,
      PT_TOKEN: "cp-stub-token",
      PT_S3_BUCKET: "cells",
      PT_S3_ENDPOINT: "127.0.0.1:19000",
      PT_S3_REGION: "us-east-1",
      MODEL_API_KEY: "sk-deploy-test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code, out }));
});

// ── preconditions come first, or a failure orphans resources ────────────────
const missing = await runDeploy({ CELLD_BIN: "definitely-not-installed-celld" });
check("a missing celld is refused with an actionable message",
  missing.code !== 0 && /not on PATH/.test(missing.out) && /Install it/.test(missing.out),
  missing.out.slice(0, 140));
check("and NOTHING was created before that refusal",
  !existsSync(LOG), existsSync(LOG) ? `${JSON.parse(readFileSync(LOG, "utf8")).length} calls were made` : "");

// ── the real run, with celld stubbed so no container is needed ──────────────
const ok = await runDeploy({ CELLD_BIN: "/usr/bin/true" });
check("the deploy completes with a stubbed celld", ok.code === 0, ok.out.slice(-200));

const calls = JSON.parse(readFileSync(LOG, "utf8"));
const post = (p, pred) => calls.filter((c) => c.method === "POST" && c.path === p && pred(c.body));
const tpl = post("/v1/templates/from-spec", () => true);
const ws = post("/v1/sandboxes", (b) => "templateId" in b);
const cell = post("/v1/sandboxes", (b) => "image" in b);

check("the workspace template is built from the GENERATED spec",
  tpl.length === 1 && tpl[0].body.name === "pt-agent-daemon" && tpl[0].body.base_image,
  JSON.stringify(tpl[0]?.body ?? {}).slice(0, 100));
check("the workspace sandbox uses that template",
  ws.length === 1 && ws[0].body.templateId === "tpl_stub_agentdaemon");
check("the daemon token reaches the WORKSPACE, which is where it is checked",
  !!(ws[0]?.body.envVars ?? {}).TOKEN);
check("the cell is created from the celld image spec, inline",
  cell.length === 1 && typeof cell[0].body.image === "object" && cell[0].body.image.entrypoint,
  JSON.stringify(cell[0]?.body?.image ?? {}).slice(0, 80));

const env = cell[0]?.body.envVars ?? {};
check("the cell's secrets ride CELLD_VAR_*, never the deployment",
  "CELLD_VAR_TOOL_DAEMON_TOKEN" in env && env.CELLD_VAR_MODEL_API_KEY === "sk-deploy-test",
  JSON.stringify(Object.keys(env)));
// cellStorage.ts refuses these for a cell; sending them would be refused by the
// control plane and, worse, would mean we tried.
const forbidden = Object.keys(env).filter((k) =>
  /^AWS_/i.test(k) || ["CELLD_BUCKET", "CELLD_ENDPOINT", "CELLD_REGION", "CELLD_STORAGE_PROBE"].includes(k));
check("NO storage credentials or redirects are sent to the cell",
  forbidden.length === 0, JSON.stringify(forbidden));
check("the cell exposes its worker port", (cell[0]?.body.exposed_ports ?? []).includes(8080));

check("the org is READ BACK from the created cell, not taken on trust",
  calls.some((c) => c.method === "GET" && c.path === "/v1/sandboxes/sbx_stub_cell"));
check("the deploy prefix names that org",
  /orgs\/org_stub_tenant/.test(ok.out), (ok.out.match(/deploying to .*/) ?? [""])[0]);
check("the cell is restarted after the bundle is written",
  calls.some((c) => c.path.endsWith("/stop")) && calls.some((c) => c.path.endsWith("/start")));
check("every call is authenticated", calls.every((c) => c.auth === "Bearer cp-stub-token"));

// The whole point of the CELLD_VAR_ design: nothing secret in the file celld
// uploads.
const vars = JSON.parse(readFileSync(wrangler, "utf8")).vars ?? {};
const leaked = Object.entries(vars).filter(([k, v]) => /(TOKEN|KEY|SECRET)/i.test(k) && !k.endsWith("_URL") && v);
check("wrangler.json is left with no secret in it", leaked.length === 0, JSON.stringify(leaked));

cp.kill();
console.log(bad ? `\n  ${bad} failure(s)` : "\n  the deploy contract holds");
process.exit(bad ? 1 : 0);
