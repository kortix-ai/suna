#!/usr/bin/env node
// celldctl — run a cell from agent.config.json instead of from memory.
//
// A cell is not a container, but locally it has to be launched like one, and
// that launch line had grown to nine flags duplicated across e2e.sh, bench.sh
// and whatever anyone last typed. Any one of them drifting — the node id, the
// bucket, the endpoint — produces failures that look like celld bugs. So the
// flags live in the config and are assembled here, once.
//
//   node celldctl.mjs up        start a node (builds + deploys first)
//   node celldctl.mjs deploy    push the worker bundle to the bucket
//   node celldctl.mjs restart   nodes load a deployment AT STARTUP
//   node celldctl.mjs down      stop the node
//   node celldctl.mjs status    what is running, and what it is serving
//   node celldctl.mjs purge     drop old deployment versions (they keep secrets)
//
// `--target platinum` is accepted and refused with the reason, rather than
// pretending: see the note in cmdUp.
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CFG = JSON.parse(readFileSync(new URL("./agent.config.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const targetName = (argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "local");
const target = CFG.targets[targetName];
if (!target) die(`no such target '${targetName}'. Known: ${Object.keys(CFG.targets).join(", ")}`);

const CONTAINER = `pt-cell-${CFG.name}`;
const sh = (bin, args, opts = {}) =>
  spawnSync(bin, args, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit", ...opts });
const out = (bin, args) => spawnSync(bin, args, { encoding: "utf8" }).stdout?.trim() ?? "";

function die(msg) { console.error(`celldctl: ${msg}`); process.exit(1); }

// Everything celld needs, derived from the config in ONE place. This function
// existing is the entire point of the file.
function celldArgs() {
  return [
    "--bucket", target.bucket,
    "--endpoint", target.endpoint,
    "--region", target.region,
    "--listen", `0.0.0.0:${CFG.cell.listen}`,
    "--internal-listen", `0.0.0.0:${CFG.cell.internal_listen}`,
    "--advertise", `127.0.0.1:${CFG.cell.internal_listen}`,
  ];
}

/** The model credential, from the environment or a subscription login. */
function modelCredential() {
  const m = CFG.model ?? {};
  if (process.env.PT_AGENT_SCRIPTED === "1") return "";
  return process.env[m.api_key_env ?? "MODEL_API_KEY"] ?? oauthTokenFor(m.provider) ?? "";
}

function dockerEnv() {
  return [
    "-e", `AWS_ACCESS_KEY_ID=${target.credentials.access_key}`,
    "-e", `AWS_SECRET_ACCESS_KEY=${target.credentials.secret_key}`,
    "-e", `AWS_REGION=${target.region}`,
    // The one that cost an afternoon. See agent.config.json cell._node.
    "-e", `CELLD_NODE=${CFG.cell.node}`,
    // 80% of the container cap: shed before the cgroup kills us.
    "-e", `CELLD_MAX_RSS_MB=${Math.floor((CFG.cell.memory_mb ?? 2048) * 0.8)}`,
    // Idle eviction is DISABLED by default in celld, so nothing ever hibernates
    // unless asked. A test that wants to prove a socket survives eviction has to
    // cause one.
    ...(process.env.CELLD_IDLE_EVICT_S ? ["-e", `CELLD_IDLE_EVICT_S=${process.env.CELLD_IDLE_EVICT_S}`] : []),
    // A hard resident cap forces an eviction without waiting on a clock.
    //
    // This used to say idle eviction "did nothing at CELLD_IDLE_EVICT_S=3".
    // That was WRONG, and wrong in a specific way worth recording: it was
    // concluded by looking for an eviction line in celld's log, and celld never
    // writes one. Measured 2026-09-02 with the epoch/fresh pair instead, an
    // idle cell goes epoch=1 fresh=true -> epoch=2 fresh=false after the
    // threshold, while a cell kept warm on the SAME node does not. Both arms
    // are claims in test/eviction.sh.
    //
    // The cap is still what the socket claims use, because it evicts on demand
    // rather than after a wait.
    ...(process.env.CELLD_MAX_RESIDENT_CELLS ? ["-e", `CELLD_MAX_RESIDENT_CELLS=${process.env.CELLD_MAX_RESIDENT_CELLS}`] : []),
    // Worker var overrides at the node: same names the worker reads, never
    // written to the bucket. Empty is fine — the worker falls back to scripted.
    //
    // The daemon token goes this way too, and not only for tidiness: if local
    // used wrangler.json while deploy.sh used CELLD_VAR_*, the CELLD_VAR_ path
    // would be the one path nothing tests. Now every e2e tool call proves it.
    "-e", `CELLD_VAR_MODEL_API_KEY=${modelCredential()}`,
    "-e", `CELLD_VAR_TOOL_DAEMON_TOKEN=${process.env.TOOL_DAEMON_TOKEN ?? "dev-token"}`,
    // The platinum tool backend. The scoped key is a secret and rides the same
    // node-var channel; the URL and the workspace id are not, but travel with it
    // so the three are always set or unset together — a half-configured backend
    // is worse than either one.
    "-e", `CELLD_VAR_PT_API_URL=${process.env.PT_API_URL ?? ""}`,
    "-e", `CELLD_VAR_PT_SANDBOX_KEY=${process.env.PT_SANDBOX_KEY ?? ""}`,
    "-e", `CELLD_VAR_PT_WORKSPACE_ID=${process.env.PT_WORKSPACE_ID ?? ""}`,
    // Where commands run inside the sandbox. Empty means the agent's default
    // (/home/user); it is a var rather than a constant because the workspace
    // is not always a VM whose home directory exists.
    "-e", `CELLD_VAR_PT_WORKSPACE_CWD=${process.env.PT_WORKSPACE_CWD ?? ""}`,
    // Lets a test trigger compaction without generating 200k tokens.
    "-e", `CELLD_VAR_CONTEXT_WINDOW=${process.env.CONTEXT_WINDOW ?? ""}`,
  ];
}

function requireLocal() {
  if (targetName !== "local") {
    die(
      `target '${targetName}' cannot be driven from here.\n` +
      `  A Platinum cell is created through the control plane, not docker: use ./deploy.sh,\n` +
      `  which builds the workspace template, creates the cell, and writes the bundle.\n` +
      `  celldctl only runs the LOCAL target, so the tests have a real celld without a control plane.`,
    );
  }
}

// The model settings live in agent.config.json, but celld reads wrangler.json.
// Syncing them here means there is still exactly ONE place to edit, and no way
// for the two files to disagree about which model a cell will call.
function syncWorkerVars() {
  const wpath = new URL("./wrangler.json", import.meta.url);
  const w = JSON.parse(readFileSync(wpath, "utf8"));
  const m = CFG.model ?? {};
  w.vars = { ...w.vars };
  // Belt and braces: anything secret that ever lands here would be uploaded.
  delete w.vars.TOOL_DAEMON_TOKEN;
  w.vars.MODEL_PROVIDER = m.provider ?? "";
  w.vars.MODEL_ID = m.id ?? "";
  w.vars.MODEL_BASE_URL = m.base_url ?? "";
  // The key comes from the ENVIRONMENT, never the config file: a committed
  // wrangler.json with a live key in it is the oldest mistake there is.
  // THE SUITE MUST NOT DEPEND ON A CREDENTIAL BEING ABSENT.
  //
  // Once a real ChatGPT login existed, e2e.sh started driving the real model:
  // the scripted turns were ignored (correctly — a configured provider wins),
  // the deterministic claims stopped holding, and a test run began costing
  // money. A suite that silently changes what it tests when someone logs in is
  // worse than a failing one.
  if (process.env.PT_AGENT_SCRIPTED === "1") {
    w.vars.MODEL_PROVIDER = "";
    delete w.vars.MODEL_API_KEY;
    writeFileSync(wpath, JSON.stringify(w, null, 2) + "\n");
    return "scripted (forced by PT_AGENT_SCRIPTED=1)";
  }
  const keyEnv = m.api_key_env ?? "MODEL_API_KEY";
  // A subscription provider (openai-codex, anthropic Pro/Max, github-copilot)
  // has no API key at all — `npx @earendil-works/pi-ai login <provider>` writes
  // an OAuth record to ./auth.json instead. Prefer that when it is present, so
  // a ChatGPT Plus/Pro login needs no key and no extra step.
  // THE CREDENTIAL NEVER GOES IN wrangler.json.
  //
  // `celld deploy` uploads that file's vars into the deployment manifest in the
  // bucket. Measured: three manifests under deploy/ptagent/ contained the whole
  // ChatGPT OAuth JWT. On Platinum that is the org's S3 prefix — a subscription
  // token, versioned, readable by anything with bucket access, surviving every
  // redeploy.
  //
  // celld supports CELLD_VAR_* env vars that override worker vars at the NODE,
  // so the secret rides the process environment and never reaches storage.
  // See modelCredential() and dockerEnv().
  delete w.vars.MODEL_API_KEY;
  writeFileSync(wpath, JSON.stringify(w, null, 2) + "\n");
  return modelCredential()
    ? `${w.vars.MODEL_PROVIDER}/${w.vars.MODEL_ID}${w.vars.MODEL_BASE_URL ? " @ " + w.vars.MODEL_BASE_URL : ""} (credential via CELLD_VAR_*, not the bucket)`
    : `scripted (no ${keyEnv} and no subscription login)`;
}

// Reads the token `pi-ai login` left behind. Deliberately tolerant: the file
// shape is the CLI's, not ours, so look for the usual field names rather than
// assuming one and failing silently on a rename.
function oauthTokenFor(provider) {
  try {
    const auth = JSON.parse(readFileSync(new URL("./auth.json", import.meta.url), "utf8"));
    const rec = auth?.[provider] ?? auth?.providers?.[provider];
    // AUDIT-EQUIVALENT: without this, reading .access off undefined throws into
    // the catch below, which answers undefined too. Explicit because "no login
    // for this provider" is a normal outcome, not an error to be swallowed.
    if (!rec) return undefined;
    // `pi-ai login` writes {type:"oauth", access, refresh, expires, accountId}.
    // `access` is the field it actually uses; the rest are accepted because this
    // file's shape belongs to the CLI, not to us, and a rename should degrade to
    // "no token" rather than to a confident wrong one.
    const tok = rec.access ?? rec.access_token ?? rec.accessToken ?? rec.token ?? rec.apiKey ?? rec.api_key;
    // AUDIT-EQUIVALENT: falling through returns the same undefined. Kept so the
    // expiry warning below cannot fire for a record that has no token at all.
    if (!tok) return undefined;
    const expires = rec.expires ?? rec.expires_at ?? rec.expiresAt;
    if (expires && Number(expires) < Date.now()) {
      console.warn(`celldctl: the ${provider} token in auth.json expired — re-run: npx @earendil-works/pi-ai login ${provider}`);
    }
    return tok;
  } catch { return undefined; }
}

/**
 * What a `celld deploy` run MEANT: a version id, or the reason there is none.
 *
 * This was one regex and no exit check. celld prints
 *
 *     Current Version ID: 3d9518e83a27310f
 *     Nodes load a deployment at startup; restart them to serve this version.
 *
 * and the version was taken from that line whatever the process did afterwards.
 * A deploy that printed the id and then failed — a signal, an upload that died
 * after the manifest went up — exited non-zero and was still reported as
 * `deployed pi-agent version X`. `up` then labelled the container with a
 * version the bucket may not fully hold, and the next `up` skipped the restart
 * because the label matched.
 *
 * Same shape as the fingerprint bug one function down: reporting success for
 * something that did not happen. So the exit status counts, and so does
 * ambiguity — two different ids in one output is not a deploy to pick from, it
 * is a deploy nobody understands.
 */
function deployOutcome({ status, stdout = "", stderr = "" }) {
  const ids = [...new Set([...String(stdout).matchAll(/Current Version ID: (\S+)/g)].map((m) => m[1]))];
  // THE FIRST-RUN FAILURE, said in one line instead of thirty-three.
  //
  // On a machine that has never run this, the bucket does not exist and celld
  // answers with three nested XML error documents. The exit code is caught
  // correctly — `up` refuses rather than reporting success — but what a new
  // developer sees is a wall of markup with the actionable word buried in it.
  const missing = /<Code>NoSuchBucket<\/Code>/.exec(`${stdout}${stderr}`)
    && /<BucketName>([^<]+)<\/BucketName>/.exec(`${stdout}${stderr}`)?.[1];
  if (missing) {
    return { error: `the bucket '${missing}' does not exist — create it before deploying (mc mb <alias>/${missing}, or point targets.local.bucket at one that exists)` };
  }
  if (status !== 0) return { error: `celld deploy exited ${status}${ids.length ? ` after printing ${ids[0]}` : ""}` };
  if (ids.length === 0) return { error: "celld printed no version id" };
  if (ids.length > 1) return { error: `celld printed more than one version id: ${ids.join(", ")}` };
  return { version: ids[0] };
}

function cmdDeploy() {
  requireLocal();
  console.log(`model      ${syncWorkerVars()}`);
  execFileSync("npm", ["run", "--silent", "build"], { stdio: "inherit" });
  const r = sh("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    "-v", `${process.cwd()}:/app`, "-w", "/app",
    ...dockerEnv(), "--add-host=host.docker.internal:host-gateway",
    target.image, "celld", "deploy", ".",
    "--bucket", target.bucket, "--endpoint", target.endpoint, "--region", target.region,
  ], { quiet: true });
  const outcome = deployOutcome(r);
  if (outcome.error) die(`deploy failed: ${outcome.error}\n${r.stdout}${r.stderr}`);
  console.log(`deployed ${CFG.name} version ${outcome.version}`);
  return outcome.version;
}

// Which deployment the RUNNING container was started against. Kept next to the
// container rather than in a file, so it cannot go stale behind a manual
// `docker rm`.
function lastStartedVersion() {
  const labels = out("docker", ["inspect", CONTAINER, "--format", "{{index .Config.Labels \"pt.deployment\"}}"]);
  return labels && labels !== "<no value>" ? labels : null;
}

// WHAT THE RUNNING CONTAINER WAS STARTED WITH, not just which bundle.
//
// The restart skip compared the deployment version alone. Node vars are passed
// with `docker run -e`, so changing one and re-running `up` printed "already
// serving" and kept the OLD value — the change silently did not apply. That is
// worst exactly where it matters most: repointing PT_WORKSPACE_ID at another
// sandbox, or rotating PT_SANDBOX_KEY, looked like it worked. A confinement
// test caught it by pointing the cell at a sandbox its key cannot reach and
// watching the command run anyway.
//
// Hashed, never stamped in the clear: these values include the model key and
// the sandbox key, and `docker inspect` labels are readable by anyone on the
// host.
/**
 * EVERYTHING THAT DECIDES WHAT THE CONTAINER IS, in one list.
 *
 * The `up` fast path skips the restart when the fingerprint matches the running
 * container's label, and the fingerprint used to hash dockerEnv() alone. The
 * image, the bucket, the endpoint, the region, the published port and the
 * listen addresses are not env vars — they are command-line arguments — so
 * changing any of them left the fingerprint identical and `up` printed
 *
 *     cell already serving <version> — not restarting
 *
 * while the old container kept running. Measured: change targets.local.bucket,
 * fingerprint unchanged; change targets.local.image, fingerprint unchanged.
 *
 * The image one is not hypothetical. Pinning a new celld version is a change to
 * exactly that field, and the answer would have been to keep the old node and
 * report success — the whole point of pinning, silently undone.
 *
 * So there is ONE list, and both the docker run and the hash are built from it.
 * Anything added to the container is in the fingerprint because there is
 * nowhere else to add it.
 */
function containerSpec() {
  return [
    "--platform", "linux/amd64",
    // HARD MEMORY BOUND, because an unbounded cell node took the host down.
    //
    // celld holds cells resident until memory pressure (CELLD_IDLE_EVICT_S is
    // disabled by default), so a benchmark that creates a few hundred sessions
    // grows without limit. On a 16 GB laptop that pushed macOS into OOM and the
    // kernel SIGKILLed the Docker VM — repeatedly, mid-suite, which then looked
    // like a bug in whatever claim happened to be running.
    //
    // Two limits, deliberately: the container cap is the backstop, and
    // CELLD_MAX_RSS_MB is set BELOW it so celld sheds cells itself rather than
    // being OOM-killed. A shed cell is a cold start; a killed node is an
    // incident.
    "--memory", `${CFG.cell.memory_mb ?? 2048}m`,
    "--memory-swap", `${CFG.cell.memory_mb ?? 2048}m`,
    "-p", `${target.host_ports.cell}:${CFG.cell.listen}`,
    ...dockerEnv(), "--add-host=host.docker.internal:host-gateway",
    target.image, "celld", ...celldArgs(),
  ];
}

function configFingerprint() {
  return createHash("sha256").update(containerSpec().join("\u0000")).digest("hex").slice(0, 16);
}

function lastStartedConfig() {
  const l = out("docker", ["inspect", CONTAINER, "--format", "{{index .Config.Labels \"pt.config\"}}"]);
  return l && l !== "<no value>" ? l : null;
}

// THE WORKSPACE IS HALF THE SYSTEM, so `up` starts it too.
//
// It did not, and the result was a cell whose every tool call failed with
// `fetch: error sending request`. The model handled that better than the
// tooling did — it retried with a heredoc, ran `pwd && ls` to diagnose, then
// said the tool service was unavailable — but no amount of model quality fixes
// a daemon nobody started. agent.config.json declares workspace.port; owning
// it here is what makes that declaration true.
function startDaemon() {
  const port = CFG.workspace?.port ?? 7070;
  const token = process.env.TOOL_DAEMON_TOKEN ?? "dev-token";
  // Claim the port rather than assume it: a daemon left over from an earlier
  // run answers /health with a DIFFERENT work root, so the suite would pass
  // against a stale workspace.
  freePort(port);
  const child = spawn(process.execPath, [new URL("./daemon/server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), TOKEN: token },
    detached: true, stdio: "ignore",
  });
  child.unref();
  const daemonDeadline = Date.now() + 10_000;
  for (let i = 0; ; i++) {
    const body = out("curl", ["-s", "-m", "1", "-H", `authorization: Bearer ${token}`, `http://127.0.0.1:${port}/health`]);
    if (body.includes('"ok":true')) return port;
    if (!pollUntil(daemonDeadline, i)) break;
  }
  die(`the tool daemon never answered on :${port}`);
}

// POLLING WAKES THE VM, AND macOS COUNTS THAT.
//
// These loops used to poll at a flat 20 Hz — curl into the VM every 50ms, on
// every `up`, in every suite. macOS SIGKILLed OrbStack Helper for it:
//
//   caught waking the CPU 45001 times over ~101 seconds, averaging 442 wakes /
//   second and violating a limit of 45000 wakes over 300 seconds
//
// That is the "docker VM died" this suite kept blaming on memory. The host had
// gigabytes free; it was the wakeup limit, and the polling was ours.
//
// Backoff keeps the fast path fast — a warm node answers on the first or second
// try — while a slow start settles to 2 Hz instead of 20. Deadline-based, so a
// longer wait costs patience rather than wakes.
/**
 * Seconds to wait before attempt `n`. Separate from the loop so the SHAPE can
 * be claimed without waiting for it: the property that matters is not any one
 * delay, it is how many wakes a long wait adds up to.
 */
// AUDIT-EQUIVALENT: the step positions are deliberately unpinned — the claims are aggregate (monotone, bounded, total polls in a window) and a one-attempt shift moves none of them.
function pollDelay(attempt) {
  return attempt < 6 ? 0.05 : attempt < 20 ? 0.25 : 0.5;
}

function pollUntil(deadlineMs, attempt) {
  if (Date.now() >= deadlineMs) return false;
  execFileSync("sleep", [String(pollDelay(attempt))]);
  return true;
}

// FREE A PORT WITHOUT KILLING THE MACHINE'S DOCKER.
//
// This was `lsof -ti tcp:PORT | xargs kill -9`, and it SIGKILLed OrbStack once
// per test sweep for weeks.
//
// `lsof -ti tcp:PORT` lists every process with a socket on that port — INCLUDING
// THE ONE AT THE OTHER END. The cell runs inside the VM and dials
// host.docker.internal:PORT, so OrbStack proxies the connection and holds an
// ESTABLISHED socket there. It appears in that list next to our daemon, and
// `xargs kill -9` does not distinguish:
//
//   pid 2757  OrbStack Helper   127.0.0.1:50937->127.0.0.1:7098 (ESTABLISHED)
//   pid 5653  node              *:7098 (LISTEN)
//
// The crash that "kept happening under Docker" was this line. Two filters, both
// necessary: only LISTEN sockets (the far end of a connection is never the
// squatter), and only a process we would recognise as ours.
function freePort(port) {
  const pids = out("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`])
    .split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    const comm = out("ps", ["-o", "comm=", "-p", pid]);
    if (!/node/i.test(comm)) continue;
    sh("kill", ["-9", pid], { quiet: true });
  }
}

/**
 * May `up` leave the running container alone?
 *
 * Five things have to agree, and every one of them is a way to end up testing
 * code that was never loaded:
 *
 *   running          nothing to keep if the container is gone
 *   version          a deploy that produced no id is not something to match
 *   version match    a new bundle is the whole reason to restart
 *   config match     a new image, bucket, port or node var is too
 *   health 200       a container that is up but wedged is not "already serving"
 *
 * A separate function because it is the decision, and because the alternative
 * is a five-term condition inside `up`, which only a Docker suite can reach and
 * which therefore nothing checks. Health is a THUNK so it is asked only when
 * everything else already agreed — the curl is a wake-up, and this is the loop
 * that used to cost OrbStack its life.
 */
function skipRestart({ running, version, startedVersion, fingerprint, startedConfig, health }) {
  if (!running) return false;
  if (!version || version !== startedVersion) return false;
  if (fingerprint !== startedConfig) return false;
  return health() === "200";
}

function cmdUp() {
  requireLocal();
  const port = startDaemon();
  console.log(`workspace  daemon on :${port}`);
  const version = cmdDeploy();

  // DO NOT RESTART A NODE THAT IS ALREADY SERVING THIS BUNDLE.
  //
  // Every suite called `up`, and `up` always did rm -f + run, so a full run
  // restarted the cell node six or more times. Restarts are the operation this
  // machine's Docker VM keeps dying under, and most of them bought nothing: the
  // bundle is usually identical between suites, and celld 0.3.0 only needs a
  // restart when the DEPLOYMENT CHANGED.
  //
  // So: same version, container up, health 200 -> leave it alone.
  const running = out("docker", ["ps", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.Status}}"]);
  const fingerprint = configFingerprint();
  const health = () => out("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2",
    `http://127.0.0.1:${target.host_ports.cell}/health`]);
  if (skipRestart({ running, version, startedVersion: lastStartedVersion(), fingerprint, startedConfig: lastStartedConfig(), health })) {
    console.log(`cell already serving ${version} — not restarting`);
    return;
  }
  sh("docker", ["rm", "-f", CONTAINER], { quiet: true });
  const started = sh("docker", [
    "run", "-d", "--name", CONTAINER,
    // Stamped so a later `up` can tell whether a restart would change anything.
    "--label", `pt.deployment=${version ?? "unknown"}`,
    // What this container was started with, hashed. A later `up` with a
    // different image, bucket, port or node var must restart rather than report
    // success — which is why the hash and this command read the SAME list.
    "--label", `pt.config=${fingerprint}`,
    ...containerSpec(),
  ], { quiet: true });
  if (started.status !== 0) {
    // Name the squatter. "port is already allocated" without saying BY WHAT is
    // the difference between a five-second fix and a hunt.
    const holder = out("docker", ["ps", "--filter", `publish=${target.host_ports.cell}`, "--format", "{{.Names}}"]);
    die(
      `docker run failed:\n${started.stderr}` +
      (holder ? `  port ${target.host_ports.cell} is held by: ${holder}\n` +
                `  run: docker rm -f ${holder}   (or change targets.local.host_ports.cell)\n` : ""),
    );
  }
  // VERIFY OUR OWN CONTAINER IS ALIVE, not merely that the port answers.
  // Another node — a leftover from an earlier run — happily holds the port and
  // replies 200, so a health check alone reports success while the container
  // just started is already dead of a bind conflict. Caught exactly that way.
  requireRunning();
  waitServing();
  console.log(`cell up on http://127.0.0.1:${target.host_ports.cell} (node ${CFG.cell.node})`);
}

function cmdRestart() {
  requireLocal();
  // Deliberately a restart and not a reload: nodes load a deployment at startup,
  // so a running node keeps serving the old bundle — silently.
  sh("docker", ["restart", CONTAINER], { quiet: true });
  waitServing();
  console.log("restarted; the node has loaded the current deployment");
}

function requireRunning() {
  const status = out("docker", ["ps", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.Status}}"]);
  if (status) return;
  const why = out("docker", ["logs", "--tail", "5", CONTAINER]) || "<no logs>";
  const holder = out("docker", ["ps", "--filter", `publish=${target.host_ports.cell}`, "--format", "{{.Names}}"]);
  die(
    `${CONTAINER} exited immediately.\n${why}\n` +
    (holder ? `  port ${target.host_ports.cell} is held by: ${holder}\n  stop it, or change targets.local.host_ports.cell\n` : ""),
  );
}

function waitServing() {
  const url = `http://127.0.0.1:${target.host_ports.cell}/health`;
  const deadline = Date.now() + 30_000;
  for (let i = 0; ; i++) {
    const code = out("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2", url]);
    if (code === "200") return;
    if (!pollUntil(deadline, i)) break;
  }
  die(`the node never served ${url}\n${out("docker", ["logs", "--tail", "20", CONTAINER])}`);
}

function cmdDown() {
  sh("docker", ["rm", "-f", CONTAINER], { quiet: true });
  const port = CFG.workspace?.port ?? 7070;
  freePort(port);
  console.log("cell down, daemon stopped");
}

// PURGE OLD DEPLOYMENT VERSIONS.
//
// celld keeps every version it has ever been given, and `deploy/current.json`
// only names the newest. That is good for rollback and bad for secrets: a
// credential that was in wrangler.json once stays in that version's manifest
// forever, and fixing the code does not remove it. Rotating a leaked secret
// therefore means purging history as well as rotating the value.
//
// Keeps the current version. Local target only — on Platinum the bucket is the
// org's, reached through the host gateway, and this is not the tool for it.
/**
 * What `purge` may delete — or why it must not delete anything.
 *
 * This runs `mc rm --recursive --force` on names parsed out of `mc ls` text,
 * which makes every weakness in the parse an irreversible one. Two were real.
 *
 * THE POINTER FILE WAS A VERSION. `mc ls` marks directories with a trailing
 * slash, and the parse stripped that slash before deciding — throwing away the
 * one signal that tells a version directory from `current.json` sitting beside
 * it. Measured against the live bucket: 48 entries, and the file naming the
 * live deployment was among the 48 it would have removed.
 *
 * A FAILED READ DELETED EVERYTHING. `keep` came from JSON.parse in a try/catch
 * that fell back to "". Nothing equals "", so a transient failure reading
 * current.json — mc not pulled, alias not set, endpoint down — turned the loop
 * into "delete every version", the live one included, and then printed
 * "kept <none>" as if that had been the plan.
 *
 * So: no version to keep is a REFUSAL, a listing that does not contain the
 * version to keep is a refusal, and a name that is not a plain token is a
 * refusal rather than something to interpolate into `sh -c`.
 */
function purgePlan(currentJson, listing) {
  let keep = "";
  try { keep = JSON.parse(currentJson)?.version ?? ""; } catch { keep = ""; }
  if (!keep) return { error: "deploy/current.json named no version — every version would look deletable" };

  const names = String(listing).split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s+/).pop()).filter(Boolean);
  // A version is a DIRECTORY. mc writes the slash; keeping it is what stops the
  // pointer file being treated as a version.
  const versions = names.filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1));
  const unsafe = versions.filter((v) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v));
  if (unsafe.length) return { error: `listing held names that are not version ids: ${unsafe.slice(0, 3).join(", ")}` };
  if (!versions.includes(keep)) {
    return { error: `the live version ${keep} is not in the listing — refusing rather than deleting what is beside it` };
  }
  return { keep, remove: versions.filter((v) => v !== keep) };
}

function cmdPurge() {
  requireLocal();
  const mc = (cmd) => out("docker", [
    "run", "--rm", "--network", "host", "--entrypoint", "sh", "quay.io/minio/mc", "-c",
    `mc alias set m ${target.endpoint.replace("host.docker.internal", "127.0.0.1")} ` +
    `${target.credentials.access_key} ${target.credentials.secret_key} >/dev/null 2>&1; ${cmd}`,
  ]);
  const base = target.bucket.replace(/^s3:\/\//, "");
  const script = CFG.name === "pi-agent" ? "ptagent" : CFG.name;
  const plan = purgePlan(
    mc(`mc cat m/${base}/deploy/${script}/current.json 2>/dev/null`),
    mc(`mc ls m/${base}/deploy/${script} 2>/dev/null`),
  );
  if (plan.error) die(`purge refused: ${plan.error}`);
  for (const v of plan.remove) mc(`mc rm --recursive --force m/${base}/deploy/${script}/${v} >/dev/null 2>&1`);
  console.log(`purged ${plan.remove.length} old version(s); kept ${plan.keep}`);
}

function cmdStatus() {
  const running = out("docker", ["ps", "--filter", `name=${CONTAINER}`, "--format", "{{.Status}}"]);
  console.log(`config     ${CFG.name} (target ${targetName})`);
  console.log(`node id    ${CFG.cell.node}`);
  console.log(`bucket     ${target.bucket ?? "<from env>"}`);
  console.log(`container  ${running || "not running"}`);
  if (running) {
    const health = out("curl", ["-s", "-m", "2", `http://127.0.0.1:${target.host_ports.cell}/health`]);
    console.log(`serving    ${health || "<no answer>"}`);
  }
  const port = CFG.workspace?.port ?? 7070;
  const token = process.env.TOOL_DAEMON_TOKEN ?? "dev-token";
  const d = out("curl", ["-s", "-m", "2", "-H", `authorization: Bearer ${token}`, `http://127.0.0.1:${port}/health`]);
  console.log(`workspace  ${d.includes('"ok":true') ? `daemon up on :${port}` : `NOT RUNNING on :${port}`}`);
  if (false) {
  }
}

// Only dispatch when RUN, so the pure parts can be imported and tested. The
// secret handling lives here — syncWorkerVars decides what reaches the bucket —
// and it was wrong once already: the credential went into wrangler.json and
// `celld deploy` uploaded it. That is worth a test, and a test needs an import.
//
// `import.meta.main` is undefined in Node (it is a Bun/Deno thing), so compare
// the module URL to argv[1] — the same mistake build-images.mjs made.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  ({ up: cmdUp, deploy: cmdDeploy, restart: cmdRestart, down: cmdDown, status: cmdStatus, purge: cmdPurge }[cmd]
    ?? (() => die(`unknown command '${cmd}'`)))();
}

export { syncWorkerVars, modelCredential, oauthTokenFor, celldArgs, dockerEnv, containerSpec, configFingerprint, deployOutcome, purgePlan, skipRestart, pollDelay, pollUntil, freePort, CFG };
