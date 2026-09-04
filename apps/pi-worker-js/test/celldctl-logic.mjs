// THE SECRET HANDLING, tested — because it was wrong once and shipped.
//
// celldctl decides what reaches the bucket. `celld deploy` uploads
// wrangler.json's vars into the deployment manifest, so anything left in that
// file is stored, versioned, and readable by anything with bucket access. Three
// manifests once held a complete ChatGPT OAuth JWT because of one line here.
//
// The fix was to send credentials as CELLD_VAR_* on the node instead. Nothing
// stopped it coming back until this file existed.
//
// Pure logic: a JSON file in, a JSON file out. No Docker, no celld, no bucket.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=84

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const WRANGLER = `${HERE}../wrangler.json`;
const AUTH = `${HERE}../auth.json`;
const BACKUP = `${HERE}../wrangler.json.testbak`;
const AUTH_BACKUP = `${HERE}../auth.json.testbak`;
const CONFIG = `${HERE}../agent.config.json`;
const CONFIG_BACKUP = `${HERE}../agent.config.json.testbak`;

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

// TWO OF THESE MUST NOT RUN AT ONCE.
//
// This suite writes the real wrangler.json and puts it back at exit. Run it
// while another copy is mid-flight — a full sweep in one terminal, a mutation
// run in another — and the second one's backup is taken from the FIRST one's
// scratch state, so the restore writes that scratch state back.
//
// CORRECTED: I said I had observed that corruption. I had not. What I saw was a
// dirty working tree while a sweep was still running, which is this suite's
// NORMAL mid-flight state — once the sweep finished, the file was byte-identical
// again. The hazard above is real and the lock is worth having; the observation
// I used to justify it was a snapshot mistaken for a result.
//
// The backup file is the lock. It exists only between the copy below and the
// restore at exit, so finding one means someone else owns the file.
if (existsSync(BACKUP)) {
  console.error(`  celldctl-logic: ${BACKUP} exists, so another run owns wrangler.json.\n` +
    "  Refusing rather than corrupting it. If no other run is live, delete that file.");
  process.exit(1);
}

// Restore whatever was here, whatever happens — this test writes real files.
copyFileSync(WRANGLER, BACKUP);
const hadAuth = existsSync(AUTH);
if (hadAuth) copyFileSync(AUTH, AUTH_BACKUP);
const restore = () => {
  copyFileSync(BACKUP, WRANGLER); unlinkSync(BACKUP);
  if (existsSync(CONFIG_BACKUP)) { copyFileSync(CONFIG_BACKUP, CONFIG); unlinkSync(CONFIG_BACKUP); }
  if (hadAuth) { copyFileSync(AUTH_BACKUP, AUTH); unlinkSync(AUTH_BACKUP); }
  else if (existsSync(AUTH)) unlinkSync(AUTH);
};
process.on("exit", restore);

const vars = () => JSON.parse(readFileSync(WRANGLER, "utf8")).vars ?? {};
const SECRETISH = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const ALLOWED = new Set(["MODEL_BASE_URL", "TOOL_DAEMON_URL", "MODEL_PROVIDER", "MODEL_ID"]);

const { syncWorkerVars, modelCredential, oauthTokenFor, dockerEnv, celldArgs, configFingerprint, deployOutcome, purgePlan, skipRestart, pollDelay, pollUntil, freePort } =
  await import("../celldctl.mjs");

// ── an API key from the environment ─────────────────────────────────────────
process.env.MODEL_API_KEY = "sk-super-secret-value";
delete process.env.PT_AGENT_SCRIPTED;
if (existsSync(AUTH)) unlinkSync(AUTH);

let summary = syncWorkerVars();
check("the credential is used", /openai|anthropic|codex|google|groq/i.test(summary), summary);
check("the summary says it did NOT go to the bucket", /CELLD_VAR/.test(summary), summary);

let leaked = Object.entries(vars()).filter(([k, v]) => SECRETISH.test(k) && !ALLOWED.has(k) && v);
check("no secret-shaped var with a value is written to wrangler.json",
  leaked.length === 0, JSON.stringify(leaked));
check("MODEL_API_KEY is absent from the deployment config",
  !("MODEL_API_KEY" in vars()), JSON.stringify(Object.keys(vars())));
check("TOOL_DAEMON_TOKEN is absent from the deployment config",
  !("TOOL_DAEMON_TOKEN" in vars()), JSON.stringify(Object.keys(vars())));
check("the non-secret vars ARE written, so the worker is configured",
  typeof vars().MODEL_PROVIDER === "string" && typeof vars().TOOL_DAEMON_URL === "string",
  JSON.stringify(vars()));

// ── the credential still reaches the node ───────────────────────────────────
const env = dockerEnv();
const joined = env.join(" ");
check("the credential rides CELLD_VAR_MODEL_API_KEY on the container",
  joined.includes("CELLD_VAR_MODEL_API_KEY=sk-super-secret-value"), joined.slice(0, 120));
check("the daemon token rides CELLD_VAR_TOOL_DAEMON_TOKEN too",
  /CELLD_VAR_TOOL_DAEMON_TOKEN=/.test(joined));
check("the node id is passed, since celld routes a cell by it",
  /CELLD_NODE=/.test(joined));

// ── a subscription login instead of a key ───────────────────────────────────
delete process.env.MODEL_API_KEY;
writeFileSync(AUTH, JSON.stringify({
  "openai-codex": { type: "oauth", access: "oauth-access-token-value", refresh: "r", expires: Date.now() + 3_600_000 },
}, null, 2));
check("an oauth login is read from auth.json's `access` field",
  oauthTokenFor("openai-codex") === "oauth-access-token-value", String(oauthTokenFor("openai-codex")));
check("a provider with no login yields nothing",
  oauthTokenFor("anthropic") === undefined, String(oauthTokenFor("anthropic")));

// ── the shape of auth.json is the CLI's, not ours ───────────────────────────
// This file is written by `pi-ai login` and can change without asking. The
// contract in the code is that a shape it does not recognise degrades to "no
// token" rather than to a confident wrong one — because a wrong credential
// surfaces as an opaque 401 several layers away from here, which is the failure
// this repo has already spent cycles on twice.
{
  const withAuth = (obj) => { writeFileSync(AUTH, JSON.stringify(obj, null, 2)); };
  for (const field of ["access_token", "accessToken", "token", "apiKey", "api_key"]) {
    withAuth({ p: { type: "oauth", [field]: `tok-${field}` } });
    check(`a token under \`${field}\` is found too`, oauthTokenFor("p") === `tok-${field}`, String(oauthTokenFor("p")));
  }
  withAuth({ providers: { nested: { access: "nested-token" } } });
  check("a login filed under `providers` is found", oauthTokenFor("nested") === "nested-token", String(oauthTokenFor("nested")));

  withAuth({ p: { type: "oauth", secret: "not-a-field-we-know" } });
  check("a record with no recognised field yields NOTHING, rather than a confident wrong value",
    oauthTokenFor("p") === undefined, String(oauthTokenFor("p")));

  writeFileSync(AUTH, "{ this is not json");
  check("an auth.json that will not parse yields nothing rather than throwing",
    oauthTokenFor("p") === undefined, String(oauthTokenFor("p")));
}

// An EXPIRED token is still returned — the CLI may refresh it — but silence
// here is what turns "your login lapsed" into an opaque 401 four layers up.
{
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    writeFileSync(AUTH, JSON.stringify({ p: { access: "stale", expires: Date.now() - 60_000 } }));
    const stale = oauthTokenFor("p");
    writeFileSync(AUTH, JSON.stringify({ p: { access: "fresh", expires: Date.now() + 3_600_000 } }));
    const fresh = oauthTokenFor("p");
    console.warn = realWarn;
    check("an expired token WARNS, naming the command that fixes it",
      warned.length === 1 && /expired/.test(warned[0]) && /login/.test(warned[0]), JSON.stringify(warned));
    check("and is still returned, because the CLI may refresh it", stale === "stale", String(stale));
    check("while a token that has not expired warns about nothing", fresh === "fresh" && warned.length === 1, JSON.stringify(warned));
  } finally { console.warn = realWarn; }
}

// Put back the login the claims below this point are written against: these
// blocks write the real auth.json, and leaving it holding a probe's fixture
// makes the next claim fail for a reason that has nothing to do with it.
writeFileSync(AUTH, JSON.stringify({
  "openai-codex": { type: "oauth", access: "oauth-access-token-value", refresh: "r", expires: Date.now() + 3_600_000 },
}, null, 2));


summary = syncWorkerVars();
check("a subscription login is used when there is no API key",
  /CELLD_VAR/.test(summary) && !/scripted/.test(summary), summary);
leaked = Object.entries(vars()).filter(([k, v]) => SECRETISH.test(k) && !ALLOWED.has(k) && v);
check("the oauth token does not reach wrangler.json either", leaked.length === 0, JSON.stringify(leaked));

// ── the test pin ────────────────────────────────────────────────────────────
process.env.PT_AGENT_SCRIPTED = "1";
summary = syncWorkerVars();
check("PT_AGENT_SCRIPTED=1 forces the scripted model even with a login present",
  /scripted/.test(summary), summary);
check("and blanks the provider, so no real model can be reached",
  vars().MODEL_PROVIDER === "", JSON.stringify(vars().MODEL_PROVIDER));
check("the credential is empty under the pin",
  dockerEnv().join(" ").includes("CELLD_VAR_MODEL_API_KEY="), "");
check("a pinned run still cannot leak a secret",
  Object.entries(vars()).filter(([k, v]) => SECRETISH.test(k) && !ALLOWED.has(k) && v).length === 0);
delete process.env.PT_AGENT_SCRIPTED;

// ── the celld invocation ────────────────────────────────────────────────────
const args = celldArgs().join(" ");
for (const flag of ["--bucket", "--endpoint", "--region", "--listen", "--internal-listen", "--advertise"]) {
  check(`celld is invoked with ${flag}`, args.includes(flag), args.slice(0, 100));
}

// ── a config change must restart the node ───────────────────────────────────
// `up` skips the restart when the deployment version is unchanged, which is
// what stopped this machine's Docker VM dying under six restarts a run. But the
// skip compared the BUNDLE only, and node vars are passed with `docker run -e`:
// changing one and re-running `up` printed "already serving" and kept the old
// value. Repointing the workspace at another sandbox, or rotating the sandbox
// key, silently did not apply.
const fpBefore = configFingerprint();
const savedWs = process.env.PT_WORKSPACE_ID;
process.env.PT_WORKSPACE_ID = "sbx_somewhere_else";
check("changing the workspace changes the config fingerprint, so `up` restarts",
  configFingerprint() !== fpBefore, `${fpBefore} vs ${configFingerprint()}`);
process.env.PT_WORKSPACE_ID = savedWs === undefined ? "" : savedWs;
if (savedWs === undefined) delete process.env.PT_WORKSPACE_ID;
check("and an unchanged config keeps the same fingerprint, so `up` still skips",
  configFingerprint() === fpBefore, `${fpBefore} vs ${configFingerprint()}`);
// The label lands on the container where anyone on the host can read it.
check("the fingerprint is a hash, never the secret values themselves",
  !configFingerprint().includes(modelCredential() || "\u0000") && /^[0-9a-f]{16}$/.test(configFingerprint()),
  configFingerprint());

// ── FREEING A PORT MUST NOT KILL THE FAR END ────────────────────────────────
// This was `lsof -ti tcp:PORT | xargs kill -9`, and it SIGKILLed OrbStack once
// per test sweep. `lsof -ti tcp:PORT` lists every process holding a socket on
// that port, INCLUDING THE PROCESS AT THE OTHER END OF A CONNECTION — and the
// cell dials host.docker.internal, so OrbStack proxies it and sits there with
// an ESTABLISHED socket next to our daemon's LISTEN.
//
// Reproduced exactly: a node process LISTENs, a non-node process connects. Only
// the listener may die.
{
  const { spawn } = await import("node:child_process");
  const PORT_UNDER_TEST = 7167;
  const listener = spawn(process.execPath, ["-e",
    `require('node:net').createServer(c=>c.on('data',()=>{})).listen(${PORT_UNDER_TEST},'127.0.0.1')`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 600));
  // The stand-in for OrbStack: not node, holding an ESTABLISHED socket.
  const farEnd = spawn("python3", ["-c",
    `import socket,time
s=socket.create_connection(('127.0.0.1',${PORT_UNDER_TEST}))
time.sleep(30)`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  check("the far end is connected before the port is freed", running(farEnd.pid) && running(listener.pid));
  freePort(PORT_UNDER_TEST);
  await new Promise((r) => setTimeout(r, 500));
  check("freeing a port kills the listener that squats it", !running(listener.pid));
  check("AND LEAVES THE PROCESS AT THE OTHER END ALIVE — this line used to SIGKILL OrbStack",
    running(farEnd.pid), "the far end was killed");
  try { farEnd.kill("SIGKILL"); } catch {}
  try { listener.kill("SIGKILL"); } catch {}
}

// ── the restart fast path is only safe if the fingerprint is complete ───────
// `up` skips restarting when the running container's pt.config label matches
// the fingerprint of what it would start. Anything that decides what the
// container IS and is missing from that hash means a change that silently does
// not take effect — `up` prints "cell already serving <version> — not
// restarting" and the old container keeps running.
//
// It hashed dockerEnv() alone. The image, bucket, endpoint, region and
// published port are command-line arguments, not env vars. Measured before the
// fix: change targets.local.bucket, fingerprint identical; change
// targets.local.image, fingerprint identical.
//
// The image one is not hypothetical. Pinning a new celld version IS a change to
// that field, and the answer would have been to keep the old node and report
// success — the pin silently undone, and every measurement after it taken
// against the version you thought you had replaced.
{
  copyFileSync(CONFIG, CONFIG_BACKUP);
  const base = readFileSync(CONFIG, "utf8");
  const fingerprintWith = async (mutate, tag) => {
    const j = JSON.parse(base);
    mutate(j);
    writeFileSync(CONFIG, JSON.stringify(j, null, 2));
    return (await import(`../celldctl.mjs?fp=${tag}`)).configFingerprint();
  };
  const baseline = await fingerprintWith(() => {}, "base");
  const again = await fingerprintWith(() => {}, "base2");
  check("the fingerprint is stable when nothing changed", baseline === again, `${baseline} vs ${again}`);

  const mutations = {
    "the bucket": (j) => { j.targets.local.bucket += "-other"; },
    "the celld image": (j) => { j.targets.local.image = "ghcr.io/example/celld:9.9.9"; },
    "the endpoint": (j) => { j.targets.local.endpoint += "/other"; },
    "the region": (j) => { j.targets.local.region = "eu-west-9"; },
    "the published port": (j) => { j.targets.local.host_ports.cell = 19999; },
    "the memory cap": (j) => { j.cell.memory_mb = 9999; },
    "the cell listen port": (j) => { j.cell.listen = 18888; },
  };
  const missed = [];
  for (const [label, mutate] of Object.entries(mutations)) {
    const fp = await fingerprintWith(mutate, label.replace(/\W+/g, ""));
    if (fp === baseline) missed.push(label);
  }
  writeFileSync(CONFIG, base);
  check("every setting that changes what the container IS changes the fingerprint",
    missed.length === 0, `not covered: ${missed.join(", ")}`);

  // The structural half: the hash and the docker run read the SAME list, so a
  // future addition cannot land in one and not the other.
  const src = readFileSync(`${HERE}../celldctl.mjs`, "utf8");
  const runArgs = src.slice(src.indexOf('const started = sh("docker", ['));
  check("the run command is built from containerSpec() rather than repeating it",
    /\.\.\.containerSpec\(\)/.test(runArgs.slice(0, 600)), runArgs.slice(0, 200));
  check("and the fingerprint hashes that same list",
    /createHash\("sha256"\)\.update\(containerSpec\(\)/.test(src));
}

// ── the polling that used to kill the machine's Docker ─────────────────────
// These loops ran at a flat 20 Hz — a curl into the VM every 50 ms, on every
// `up`, in every suite — and macOS SIGKILLed OrbStack Helper for it:
//
//   caught waking the CPU 45001 times over ~101 seconds, averaging 442 wakes /
//   second and violating a limit of 45000 wakes over 300 seconds
//
// That is the "the Docker VM keeps dying" this repo blamed on memory for weeks.
// The host had gigabytes free. The wakeups were ours.
//
// So the backoff is not a nicety, it is the fix, and what has to be claimed is
// not any single delay but the TOTAL over a long wait — the number macOS
// actually counts. Computed from the schedule rather than waited out, because a
// claim that takes five minutes to run is a claim nobody runs.
{
  const pollsWithin = (seconds) => {
    let elapsed = 0, n = 0;
    while (elapsed < seconds) { elapsed += pollDelay(n); n++; }
    return n;
  };
  const over300 = pollsWithin(300);
  check("a five-minute wait costs a few hundred polls, not six thousand",
    over300 <= 700, `${over300} polls in the 300s window macOS measures (flat 20Hz would be 6000)`);
  check("and a one-minute wait costs under 200",
    pollsWithin(60) < 200, `${pollsWithin(60)} polls`);

  // The other half: backing off must not make a warm node slow to notice. The
  // fast path is the common one — the container is already up and answers on
  // the first or second try.
  const firstTwo = pollDelay(0) + pollDelay(1);
  check("the first two attempts cost under 150ms in total, so a warm node is not made to wait",
    firstTwo < 0.15, `${firstTwo}s`);

  const delays = Array.from({ length: 200 }, (_, n) => pollDelay(n));
  check("the delay never DECREASES as attempts go on",
    delays.every((d, n) => n === 0 || d >= delays[n - 1]), JSON.stringify(delays.filter((d, n) => n > 0 && d < delays[n - 1])));
  check("and is bounded, so a slow start is still noticed within half a second",
    Math.max(...delays) <= 0.5, String(Math.max(...delays)));

  // Termination. Every one of these loops is `for (;;)` with pollUntil as the
  // only way out, so a pollUntil that never returns false is a hang in CI with
  // no output.
  check("pollUntil says stop once the deadline has passed",
    pollUntil(Date.now() - 1, 0) === false);
  check("and says stop exactly AT the deadline, not one poll later",
    pollUntil(Date.now(), 0) === false);
  const t0 = Date.now();
  const cont = pollUntil(Date.now() + 5_000, 0);
  const waited = Date.now() - t0;
  check("while before the deadline it continues, having actually WAITED rather than spun",
    cont === true && waited >= 40, `${waited}ms`);
}

// ── what a deploy MEANT ─────────────────────────────────────────────────────
// The version was one regex over stdout and no exit check at all. celld can
// print the id and then fail — a signal, an upload that dies after the manifest
// is up — and every one of those was reported as `deployed pi-agent version X`.
// `up` then labels the container with a version the bucket may not fully hold,
// and the NEXT `up` skips the restart because the label matches.
//
// Same shape as the fingerprint bug: reporting success for something that did
// not happen.
//
// The fixture is real: captured from celld 0.3.0 on 2026-09-03, verbatim, so a
// wording change in celld fails here rather than in a deploy.
{
  const REAL = [
    " celld 0.3.0",
    "───────────────────────────────────────────────",
    "Total Upload: 3003.36 KiB / gzip: 449.94 KiB",
    "Your Worker has access to the following bindings:",
    "Binding                         Resource",
    "env.AGENT (AgentCell)           Durable Object (SQLite)",
    "Bundled ptagent (0.27 sec)",
    "Uploaded ptagent (0.06 sec)",
    "  s3://cells/orgs/demo/deploy/ptagent/3d9518e83a27310f",
    "Current Version ID: 3d9518e83a27310f",
    "Nodes load a deployment at startup; restart them to serve this version.",
  ].join("\n") + "\n";

  check("the real celld 0.3.0 output yields the version id",
    deployOutcome({ status: 0, stdout: REAL }).version === "3d9518e83a27310f",
    JSON.stringify(deployOutcome({ status: 0, stdout: REAL })));
  // The same hash also appears in the s3:// line above it. Taking the first
  // thing that looks like a version rather than the labelled one is how a
  // parser starts pinning the wrong string.
  check("and takes it from the labelled line, not from the s3:// path that repeats it",
    (REAL.match(/3d9518e83a27310f/g) ?? []).length === 2, "fixture should contain the id twice");

  const failed = deployOutcome({ status: 1, stdout: REAL });
  check("a NON-ZERO exit is a failure even though the output carries a version id",
    failed.version === undefined && /exited 1/.test(failed.error), JSON.stringify(failed));
  const signalled = deployOutcome({ status: null, stdout: REAL });
  check("and so is being killed by a signal, where the status is not a number",
    signalled.version === undefined, JSON.stringify(signalled));
  check("the error says the id WAS printed, so the reader knows the upload got that far",
    /3d9518e83a27310f/.test(failed.error), failed.error);

  // THE FIRST RUN. On a machine that has never done this the bucket does not
  // exist, and celld answers with three nested XML error documents — 33 lines,
  // with the one useful word buried in them. The exit code was already caught,
  // so `up` refused rather than reporting success; what was missing was saying
  // WHICH thing to go and do.
  const noBucket = deployOutcome({
    status: 1,
    stderr: '<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><BucketName>cells</BucketName></Error>',
  });
  check("a missing bucket is named, with what to do about it",
    /bucket 'cells' does not exist/.test(noBucket.error ?? "") && /mc mb/.test(noBucket.error ?? ""),
    JSON.stringify(noBucket));
  check("and it is preferred over the bare exit code, which says nothing actionable",
    !/exited 1/.test(noBucket.error ?? ""), String(noBucket.error));

  const silent = deployOutcome({ status: 0, stdout: "Total Upload: 1 KiB\n" });
  check("a clean exit with no version id is still a failure, not an undefined version",
    silent.version === undefined && /no version id/.test(silent.error), JSON.stringify(silent));

  check("two DIFFERENT ids in one output is refused rather than picked from",
    deployOutcome({ status: 0, stdout: "Current Version ID: aaa\nCurrent Version ID: bbb\n" }).version === undefined,
    JSON.stringify(deployOutcome({ status: 0, stdout: "Current Version ID: aaa\nCurrent Version ID: bbb\n" })));
  check("while the same id twice is not ambiguous and is accepted",
    deployOutcome({ status: 0, stdout: "Current Version ID: aaa\nCurrent Version ID: aaa\n" }).version === "aaa");
}

// ── when `up` is allowed to leave the container alone ───────────────────────
// `up` skips the restart when the running node is already serving this bundle,
// and that is worth having: restarts are what this machine's Docker VM keeps
// dying under. But every term of the decision is a way to end up testing code
// that was never loaded — the worst outcome a deploy tool has, because
// everything downstream still passes.
//
// It lived as a five-term condition inside cmdUp, reachable only by a suite
// with Docker, so nothing checked it. As a function, all five are claimable
// here, and the interesting half is the FALSE cases: a decision that always
// restarts is safe, one that skips wrongly is silent.
{
  const agreeing = {
    running: "Up 3 minutes", version: "v2", startedVersion: "v2",
    fingerprint: "cfg-abc", startedConfig: "cfg-abc", health: () => "200",
  };
  check("with everything in agreement and the node healthy, the container is left alone",
    skipRestart(agreeing) === true);

  const mustRestart = {
    "the container is gone": { running: "" },
    "the deploy produced no version id": { version: undefined },
    "the bundle is NEW": { startedVersion: "v1" },
    "the container was started from a different image, bucket or port": { startedConfig: "cfg-old" },
    "the label is missing entirely": { startedVersion: null, startedConfig: null },
    "the node is up but answers nothing": { health: () => "000" },
    "the node is up but answers 500": { health: () => "500" },
  };
  const wrongly = Object.entries(mustRestart).filter(([, over]) => skipRestart({ ...agreeing, ...over }) !== false);
  check("and it restarts in every case where the running node might not be what was just deployed",
    wrongly.length === 0, `wrongly skipped: ${wrongly.map(([k]) => k).join("; ")}`);

  // The health check is a curl into the VM, and polling the VM is what got
  // OrbStack SIGKILLed. It must not run for a container that is already
  // disqualified.
  let asked = 0;
  const counting = { ...agreeing, health: () => { asked++; return "200"; } };
  skipRestart({ ...counting, running: "" });
  skipRestart({ ...counting, startedVersion: "v1" });
  skipRestart({ ...counting, startedConfig: "other" });
  check("health is not asked at all when something else already decided it",
    asked === 0, `asked ${asked} times`);
  skipRestart(counting);
  check("and is asked once when it is the last thing left to check", asked === 1, `asked ${asked} times`);
}

// ── purge deletes, so it has to be sure ─────────────────────────────────────
// `purge` runs `mc rm --recursive --force` on names parsed out of `mc ls` text.
// Every weakness in that parse is an irreversible one, and two were real.
//
// Fixtures captured from the live bucket on 2026-09-03, verbatim, because the
// bug was IN the shape: `mc ls` lists the pointer file right alongside the
// version directories, and only the trailing slash tells them apart.
{
  const LISTING = [
    "[2026-09-03 20:12:12 UTC]   149B STANDARD current.json",
    "[2026-09-03 20:17:57 UTC]     0B 0aa2d46aaa6ab790/",
    "[2026-09-03 20:17:57 UTC]     0B 101e7a0d6063dd34/",
    "[2026-09-03 20:17:57 UTC]     0B f52019b23292ad01/",
  ].join("\n") + "\n";
  const CURRENT = JSON.stringify({
    script_name: "ptagent", version: "f52019b23292ad01",
    prefix: "deploy/ptagent/f52019b23292ad01", rollout: { percent: 100 },
  });

  const plan = purgePlan(CURRENT, LISTING);
  check("the live version is kept", plan.keep === "f52019b23292ad01", JSON.stringify(plan));
  check("and the older versions are the ones removed",
    JSON.stringify(plan.remove) === JSON.stringify(["0aa2d46aaa6ab790", "101e7a0d6063dd34"]), JSON.stringify(plan.remove));
  // THE BUG. `mc ls` lists current.json beside the version directories, and the
  // old parse stripped the trailing slash before deciding — throwing away the
  // only thing that told them apart. Measured against the live bucket: 48
  // entries, and the file naming the live deployment was among the 48 it would
  // have deleted.
  check("current.json is NOT treated as a version — it is the file that says which one is live",
    !plan.remove.includes("current.json"), JSON.stringify(plan.remove));

  // THE OTHER BUG, and the worse one. `keep` came from a JSON.parse in a
  // try/catch that fell back to "". Nothing equals "", so a transient failure
  // reading current.json turned the loop into "delete every version", the live
  // one included, and printed "kept <none>" as though that had been the plan.
  const blind = purgePlan("", LISTING);
  check("a current.json that cannot be read is a REFUSAL, not a licence to delete everything",
    blind.remove === undefined && /no version/.test(blind.error), JSON.stringify(blind));
  check("and so is one that parses but names no version",
    purgePlan("{}", LISTING).remove === undefined);
  check("the refusal says why, so it reads as a decision rather than a crash",
    /every version would look deletable/.test(blind.error), blind.error);

  // The listing and current.json have to agree. If the version that is supposed
  // to be live is not there, something is wrong that deleting will not fix.
  const mismatched = purgePlan(JSON.stringify({ version: "deadbeefdeadbeef" }), LISTING);
  check("a live version missing from the listing is refused rather than purged around",
    mismatched.remove === undefined && /not in the listing/.test(mismatched.error), JSON.stringify(mismatched));
  check("an empty listing is refused too — an ls that returned nothing is a failure, not an empty bucket",
    purgePlan(CURRENT, "").remove === undefined);

  // These names are interpolated into `sh -c`. A listing line that is not a
  // version id must not become part of a command.
  const hostile = purgePlan(CURRENT, LISTING + "[2026-09-03 20:17:57 UTC]     0B a;rm -rf //\n");
  check("a name that is not a plain token is refused rather than shelled",
    hostile.remove === undefined && /not version ids/.test(hostile.error), JSON.stringify(hostile));

  const only = purgePlan(CURRENT, "[2026-09-03 20:17:57 UTC]     0B f52019b23292ad01/\n");
  check("a bucket holding only the live version removes nothing, and is not an error",
    only.error === undefined && only.remove.length === 0, JSON.stringify(only));
}

// ── the scanner that stands between a credential and the bucket ─────────────
// e2e ends by walking every deployed object and asking whether any of them
// carries a secret VALUE. That check has caught a real leak — three manifests
// once held a complete OAuth JWT — and its own header records that the FIRST
// version reported clean while a planted canary sat in the manifest, because it
// pattern-matched a serialisation instead of parsing it.
//
// It runs only inside e2e, against a live bucket, so nothing exercised the
// judgement itself. Here it is fed the shapes directly.
{
  // A FAILURE TO RUN IT IS NOT A RESULT. Without the `status` check this
  // swallowed a ReferenceError and handed back {code: undefined, out: ""} —
  // and an empty output made "the value is not echoed in full" pass while the
  // scanner had never executed. Exactly the shape these claims are hunting.
  const scan = (input) => {
    try {
      return { code: 0, out: execFileSync("python3", [`${HERE}scan-secrets.py`], { input, encoding: "utf8" }) };
    } catch (e) {
      if (typeof e.status !== "number") throw new Error(`scan-secrets.py did not run: ${e.message}`);
      return { code: e.status, out: String(e.stdout ?? "") };
    }
  };
  const object = (bindings) => `a/b.json\0${JSON.stringify({ raw_metadata: { bindings } })}\0`;

  // The real deployed shape: {name, text, type}, not {name: text}. Getting that
  // wrong is what let the canary through.
  const leaked = scan(object([{ name: "MODEL_API_KEY", text: "sk-a-real-looking-value", type: "plain_text" }]));
  check("a credential VALUE in the deployed shape is caught", leaked.code === 1 && /MODEL_API_KEY/.test(leaked.out), JSON.stringify(leaked).slice(0, 140));
  check("and the finding names the var while truncating the value it found",
    /MODEL_API_KEY=sk-a-rea… \(23 chars\)/.test(leaked.out) && !leaked.out.includes("sk-a-real-looking-value"),
    leaked.out.slice(0, 140));

  const jwt = scan(`a/b.json\0{"anything":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"}\0`);
  check("a JWT anywhere in a body is caught, whatever the key is called", jwt.code === 1 && /JWT/.test(jwt.out), jwt.out.slice(0, 120));

  const benign = scan(object([{ name: "MODEL_ID", text: "gpt-5.6-luna", type: "plain_text" }]));
  check("an ordinary var is not a finding", benign.code === 0 && /scanned=1/.test(benign.out), benign.out.slice(0, 120));
  const address = scan(object([{ name: "MODEL_BASE_URL", text: "https://api.example.com", type: "plain_text" }]));
  check("nor is a name that carries the word but is an address", address.code === 0, address.out.slice(0, 120));
  const named = scan(object([{ name: "MODEL_API_KEY", text: "", type: "plain_text" }]));
  check("nor a secret-shaped NAME with no value — that is the config doing its job",
    named.code === 0, named.out.slice(0, 120));

  // The allow-list is INERT, and that is worth writing down rather than
  // discovering. It exists so a name carrying the word but meaning an address
  // is not a finding — and measured: not one of its four entries is a name the
  // secret pattern would flag in the first place, so removing the whole check
  // changes nothing today. Verified by mutation: dropping it fails no claim.
  //
  // Claimed in the direction that matters. The day someone adds an entry the
  // pattern DOES match — AUTH_URL, say — this fails and says to test the
  // exemption for real, which is the moment it stops being decoration.
  const inert = execFileSync("python3", ["-c",
    "import re,sys;sys.path.insert(0,'" + HERE + "');import importlib.util as u;" +
    "s=u.spec_from_file_location('m','" + HERE + "scan-secrets.py');m=u.module_from_spec(s);s.loader.exec_module(m);" +
    "print(','.join(n for n in sorted(m.ALLOWED) if m.SECRET_NAME.search(n)))"], { encoding: "utf8" }).trim();
  check("every name on the allow-list is one the secret pattern would ignore anyway — the list is inert",
    inert === "", `these are exempted and WOULD otherwise be flagged, so the exemption needs its own claim: ${inert}`);

  // The one that could not fail. With nothing to walk the answer is trivially
  // "no secrets", and a renamed prefix or a broken alias produces exactly that.
  const nothing = scan("");
  check("A SCAN THAT EXAMINED NOTHING IS NOT A PASS — it exits 2, distinctly from a finding",
    nothing.code === 2 && /scanned nothing/.test(nothing.out), JSON.stringify(nothing).slice(0, 140));
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  celldctl keeps secrets out of the deployment");
process.exit(bad ? 1 : 0);
