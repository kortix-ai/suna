#!/usr/bin/env node
// DEPLOY THE pi-worker-js BRANCH TO https://pi-js.kortix.com.
//
//   node apps/pi-worker-js/env/pi-js-deploy.mjs [--sha <full sha>] [--fresh]
//
// --sha defaults to origin/pi-worker-js. Its images (kortix/kortix-{api,
// gateway,frontend}:pr-<sha>) must exist on Docker Hub: the PR's `preview`
// label or a deploy-preview dispatch builds them. --fresh rebuilds the
// environment from scratch (new database); the default upgrades in place.
//
// Uploads pi-js-host.sh to the environment's VM through Platinum's file API,
// starts it detached (a Platinum exec call ends after ~85 s), and polls its
// phase until it exits. The Platinum DEV token is read from PT_TOKEN, else the
// `default` profile of ~/.config/platinum/credentials; it is never printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.PT_API_URL ?? "https://api-dev.platinum.dev";
const SANDBOX = process.env.PI_JS_SANDBOX ?? "sbx_01M1SJ00XFM1AXHQ1YA1E296G6"; // kortix-env-pi-worker-js
const argv = process.argv.slice(2);
const fresh = argv.includes("--fresh");
const sha = argv.includes("--sha")
  ? argv[argv.indexOf("--sha") + 1]
  : execFileSync("git", ["rev-parse", "origin/pi-worker-js"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--sha must be a full commit sha, got ${sha}`);

function token() {
  if (process.env.PT_TOKEN) return process.env.PT_TOKEN;
  for (const line of readFileSync(join(homedir(), ".config/platinum/credentials"), "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key.trim() === "default") return rest.join("=").trim().replace(/^"|"$/g, "");
  }
  throw new Error("no Platinum token: set PT_TOKEN or the default profile");
}
const headers = { authorization: `Bearer ${token()}`, "user-agent": "pi-js-deploy" };
async function exec(cmd, timeoutMs = 30_000) {
  const res = await fetch(`${API}/v1/sandboxes/${SANDBOX}/exec`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cmd, timeout_ms: timeoutMs }),
  });
  if (!res.ok) throw new Error(`exec -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.result?.stdout ?? "").trim();
}

const script = readFileSync(new URL("./pi-js-host.sh", import.meta.url));
const put = await fetch(`${API}/v1/sandboxes/${SANDBOX}/files?path=/workspace/pi-js-host.sh&mode=0755`, {
  method: "PUT",
  headers: { ...headers, "content-type": "application/octet-stream" },
  body: script,
});
if (!put.ok) throw new Error(`upload -> ${put.status}`);
const images = await Promise.all(["kortix-api", "kortix-gateway", "kortix-frontend"].map(async (repo) => {
  const r = await fetch(`https://hub.docker.com/v2/repositories/kortix/${repo}/tags/pr-${sha}`);
  return [repo, r.status];
}));
const missing = images.filter(([, status]) => status !== 200).map(([repo]) => repo);
if (missing.length) throw new Error(`no pr-${sha} image on Docker Hub for ${missing.join(", ")} — add the PR's preview label first`);

const mode = fresh ? "fresh" : "upgrade";
console.log(`pi-js: ${mode} -> ${sha}`);
// The previous run's phase and exit files go first: a launch that never starts
// must time out, not read as the last run's "done 0".
await exec(`rm -f /workspace/kortix-preview/pi-js.phase /workspace/kortix-preview/pi-js.exit; setsid nohup bash /workspace/pi-js-host.sh ${mode} ${sha} >/dev/null 2>&1 < /dev/null & sleep 2; cat /workspace/kortix-preview/pi-js.phase`);
let last = "";
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  // Each file ends in a newline: "done\n\n0". Blank lines are not fields.
  const [phase, exit] = (await exec("cat /workspace/kortix-preview/pi-js.phase; echo; cat /workspace/kortix-preview/pi-js.exit 2>/dev/null").catch(() => ""))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  if (phase && phase !== last) { console.log(`  ${new Date().toISOString().slice(11, 19)} ${phase}`); last = phase; }
  if (exit !== undefined && exit !== "") {
    if (exit !== "0") {
      console.error(await exec("tail -40 /workspace/kortix-preview/pi-js.log"));
      process.exit(1);
    }
    const health = await fetch("https://pi-js.kortix.com/v1/health").then((r) => r.json());
    console.log(`pi-js.kortix.com serves ${health.commit}`);
    process.exit(health.commit === sha ? 0 : 1);
  }
}
throw new Error("pi-js deploy did not finish in 40 min");
