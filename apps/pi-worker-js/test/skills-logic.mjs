// SKILLS, READ FROM THE WORKSPACE THE AGENT WORKS IN.
//
// pi ships the loader — it walks the directory, parses SKILL.md frontmatter,
// reports diagnostics — and it takes an ExecutionEnv, which is the interface
// this cell already implements. So these claims are not about re-implementing
// any of that. They are about the three places the seam can be wrong: what
// reaches the system prompt, whether a reload actually re-reads, and whether a
// broken skills directory can take a turn down with it.
//
// Driven through the SHIPPED BUNDLE (dist/worker.js) over a real daemon.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=22

import { mkdir, rm, writeFile } from "node:fs/promises";
import { installWorkerGlobals, makeCell } from "./cell-harness.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "skills-token";
process.env.WORK_ROOT = "/tmp/skills-cell-work";
const PORT = 7153;
// The workspace of the session under test: the daemon roots each session at
// WORK_ROOT/<sessionId>, and skills must come from the session the AGENT works
// in. Written under "s1" so a fixture in some other directory cannot make the
// claims pass.
const SESSION = "s1";
const SKILLS = `${process.env.WORK_ROOT}/${SESSION}/.pi/skills`;
await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await mkdir(`${SKILLS}/deploy`, { recursive: true });
await mkdir(`${SKILLS}/review`, { recursive: true });
const skillFile = (dir, name, desc, body) =>
  writeFile(`${SKILLS}/${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);
await skillFile("deploy", "deploy", "How to ship this service to dev", "Run deploy.sh, then verify /health.");
await skillFile("review", "review", "The review checklist for this repo", "Migrations are append-only.");

const { createDaemon } = await import("../daemon/server.js");
const server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

installWorkerGlobals();
const { AgentCell } = await import("../dist/worker.js");
const ENV = {
  TOOL_DAEMON_URL: `http://127.0.0.1:${PORT}`,
  TOOL_DAEMON_TOKEN: "skills-token",
  SCRIPT: JSON.stringify([{ text: "ok" }]),
};
// The daemon roots each session at WORK_ROOT/<sessionId>, and skills are loaded
// under the session id "skills" — so the fixture above is written there.
const cell = makeCell(AgentCell, ENV);
const call = (c) => ({
  get: async (p) => await (await c.fetch(p)).json(),
  post: async (p, b) => {
    const res = await c.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  },
});
const { get, post } = call(cell);

// ── what the cell can see ───────────────────────────────────────────────────
let s = await get(`/skills?c=${SESSION}`);
check("the workspace's skills are found", s.skills.length === 2 && s.skills.map((k) => k.name).sort().join(",") === "deploy,review",
  JSON.stringify(s.skills).slice(0, 140));
check("the skills directory is reported as an absolute path the model could use",
  (s.dirs ?? []).every((d) => d.startsWith("/")), JSON.stringify(s.dirs));
check("a clean workspace produces no diagnostics", (s.diagnostics ?? []).length === 0, JSON.stringify(s.diagnostics));

// ── what reaches the model ──────────────────────────────────────────────────
// The prompt carries name, description and location. NOT the content: a skill
// is read by the model when it is relevant, and putting bodies in the prompt
// would bill every turn for every skill.
const { loadWorkspaceSkills, withSkills } = await import("../src/skills.js");
const { executionEnvFor } = await import("../src/pitools.js");
const loaded = await loadWorkspaceSkills(ENV, (opId) => executionEnvFor(ENV, SESSION, opId));
check("the system prompt block names each skill and where it lives",
  loaded.block.includes("deploy") && loaded.block.includes("How to ship") && loaded.block.includes("SKILL.md"),
  loaded.block.slice(0, 120));
check("THE SKILL BODIES ARE NOT IN THE PROMPT — only the model's read tool pulls those",
  !loaded.block.includes("Run deploy.sh") && !loaded.block.includes("append-only"),
  loaded.block.slice(0, 200));
check("with no skills the prompt is returned untouched, with no empty block",
  withSkills("BASE", "") === "BASE" && withSkills("BASE", "X") === "BASE\n\nX");

// ── a reload really re-reads ────────────────────────────────────────────────
// The trap: loading LISTS and READS through the daemon, which caches every op
// by id. A fixed op prefix would replay the first load's reads forever — edit a
// SKILL.md, reload, and get the old description back. The prefix is fresh per
// load precisely so this claim can hold.
await skillFile("deploy", "deploy", "CHANGED - ship it to production", "Run deploy.sh, then verify /health.");
const cached = await get(`/skills?c=${SESSION}`);
check("without a reload the cell serves what it already had",
  cached.skills.find((k) => k.name === "deploy").description === "How to ship this service to dev",
  JSON.stringify(cached.skills.find((k) => k.name === "deploy")));
const reloaded = await get(`/skills?c=${SESSION}&reload=1`);
check("A RELOAD RE-READS THE FILE rather than replaying the cached op",
  reloaded.skills.find((k) => k.name === "deploy").description === "CHANGED - ship it to production",
  JSON.stringify(reloaded.skills.find((k) => k.name === "deploy")));

// ── a broken skill is reported, not fatal ───────────────────────────────────
await mkdir(`${SKILLS}/bad`, { recursive: true });
await writeFile(`${SKILLS}/bad/SKILL.md`, "---\nname:\ndescription:\n---\n\nnothing valid here\n");
const withBad = await get(`/skills?c=${SESSION}&reload=1`);
check("a skill with invalid metadata is skipped and reported, not silently absent",
  (withBad.diagnostics ?? []).length >= 1, JSON.stringify(withBad.diagnostics).slice(0, 160));
check("and the good skills still load alongside it",
  withBad.skills.length === 2, JSON.stringify(withBad.skills.map((k) => k.name)));

// ── a turn still runs when skills are broken ────────────────────────────────
const ran = await post(`/prompt?c=${SESSION}`, { text: "hello" });
check("a turn runs with a broken skills directory present", ran.status === 200, JSON.stringify(ran).slice(0, 120));

// ── explicit invocation ─────────────────────────────────────────────────────
const invoked = await post(`/prompt?c=${SESSION}`, { skill: "review", text: "check the migration" });
check("invoking a skill by name is accepted", invoked.status === 200, JSON.stringify(invoked).slice(0, 120));
// A cell IS a session: `c` names the session the agent runs under, but the
// transcript is the cell's one table — so this is the LAST user message, not
// the first, which is still the earlier turn's "hello".
const hist = await get(`/history?c=${SESSION}`);
const last = [...hist.messages].reverse().find((m) => m.role === "user");
const text = JSON.stringify(last?.message ?? {});
check("the user message is pi's own skill invocation, carrying the instructions",
  text.includes("review") && text.includes("check the migration"), text.slice(0, 200));

const missing = await post(`/prompt?c=${SESSION}`, { skill: "nope", text: "x" });
check("an unknown skill is a 404 naming what IS available, not a prompt about a skill that does not exist",
  missing.status === 404 && JSON.stringify(missing.body.available).includes("deploy"),
  JSON.stringify(missing).slice(0, 160));

// ── a missing skills directory is normal ────────────────────────────────────
const bare = makeCell(AgentCell, { ...ENV, SKILLS_DIR: ".pi/does-not-exist" });
const bareCall = call(bare);
const none = await bareCall.get(`/skills?c=${SESSION}`);
check("a workspace with no skills directory loads zero skills without erroring",
  none.skills.length === 0 && (none.diagnostics ?? []).length === 0, JSON.stringify(none).slice(0, 140));
const bareRan = await bareCall.post(`/prompt?c=${SESSION}`, { text: "hi" });
check("and a turn runs normally there", bareRan.status === 200, JSON.stringify(bareRan).slice(0, 120));

await new Promise((r) => server.close(r));
// ── a cell with skills switched off builds nothing ─────────────────────────
// loadWorkspaceSkills runs on every turn. SKILLS_DIR="" is how a deployment says
// "this cell has no skills", and the early return is what stops it building an
// ExecutionEnv anyway — which on the Platinum backend is a remote client and an
// op-id prefix spent on a lookup that was always going to be empty.
//
// The answer is the same either way, so the claim is about whether the env
// factory was CALLED.
{
  let built = 0;
  const factory = (opId) => { built++; return executionEnvFor(ENV, SESSION, opId); };
  const off = await loadWorkspaceSkills({ SKILLS_DIR: "" }, factory);
  check("SKILLS_DIR=\"\" yields no skills and no directories",
    off.skills.length === 0 && off.dirs.length === 0, JSON.stringify(off).slice(0, 100));
  check("and NO execution env is built for it — every turn would otherwise pay for a lookup that cannot find anything",
    built === 0, `${built} env(s) built`);
  // The default is NOT off: an env with nothing set still looks in .pi/skills,
  // so the branch above is a deliberate switch rather than the common path.
  check("while the default configuration does look for skills",
    (await loadWorkspaceSkills({}, factory)).dirs.length === 1 && built === 1,
    `${built} env(s) built`);

  // A directory that is ALREADY absolute needs no resolving. The answer is the
  // same either way — absolutePath hands an absolute path back unchanged — so
  // what moves is a round trip through the workspace, per directory, per turn.
  let resolves = 0;
  const counting = (opId) => {
    const env = executionEnvFor(ENV, SESSION, opId);
    return { ...env, absolutePath: (p) => { resolves++; return env.absolutePath(p); } };
  };
  const abs = await loadWorkspaceSkills({ SKILLS_DIR: "/tmp/skills-abs-a,/tmp/skills-abs-b" }, counting);
  check("an absolute skills directory is used as-is, with no round trip to resolve it",
    resolves === 0, `${resolves} absolutePath call(s) for ${JSON.stringify(abs.dirs)}`);
  check("and both of them come back as the absolute paths they were",
    JSON.stringify(abs.dirs) === JSON.stringify(["/tmp/skills-abs-a", "/tmp/skills-abs-b"]), JSON.stringify(abs.dirs));
  const relDir = await loadWorkspaceSkills({ SKILLS_DIR: "some/relative" }, counting);
  check("while a relative one IS resolved, once",
    resolves === 1 && relDir.dirs[0].startsWith("/"), `${resolves} call(s), ${JSON.stringify(relDir.dirs)}`);
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  skills come from the workspace: ${claims} claims`);
process.exit(bad ? 1 : 0);
