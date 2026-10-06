// SKILLS, READ FROM THE WORKSPACE THE AGENT WORKS IN.
//
// pi ships the loader — it walks the directory, parses SKILL.md frontmatter,
// reports diagnostics — and it takes an ExecutionEnv, which is the interface
// this cell implements over its own tree (src/execenv.cell.js). So these claims
// are not about re-implementing any of that. They are about the places the
// seam can be wrong: what reaches the model's system prompt, whether a reload
// actually re-reads, and whether a broken skills directory can take a turn
// down with it.
//
// Driven through the SHIPPED BUNDLE (dist/worker.js). The skills live in the
// cell's own tree, which is the session's workspace; "what reaches the model"
// is read off the request the gateway mock receives.
//
// Explicit invocation by name (`POST /prompt {skill}`) went with the old route
// table in e7ba174195: kortixd's prompt verbs carry no skill field, and
// `/session/:id/command` answers that a pi cell has no slash commands.
// EXPECTED_PASSES=23

import { installWorkerGlobals, makeCell, newMessageId, rootIdOf } from "./cell-harness.mjs";
import { startGatewayMock, systemPromptOf } from "./openai-compat.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

installWorkerGlobals();
const { AgentCell } = await import("../dist/worker.js");
const { loadWorkspaceSkills, withSkills } = await import("../src/skills.js");
const { cellExecutionEnv } = await import("../src/execenv.cell.js");

const gw = await startGatewayMock({ reply: () => ({ text: "ok" }) });
const SESSION = "s1";
const ENV = { KORTIX_SESSION_ID: SESSION, KORTIX_TOKEN: "tok-skills", KORTIX_LLM_BASE_URL: gw.url };
const cell = makeCell(AgentCell, ENV);
// A request first: the cell builds its tables on the first one (init()), and
// its tree is read through them.
await cell.fetch("/kortix/health");
const tree = () => cellExecutionEnv(cell.cell.cell());
const skillFile = (dir, name, desc, body) =>
  tree().writeFile(`.pi/skills/${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);
await skillFile("deploy", "deploy", "How to ship this service to dev", "Run deploy.sh, then verify /health.");
await skillFile("review", "review", "The review checklist for this repo", "Migrations are append-only.");
const listed = async (c = cell) => (await (await c.fetch("/skill")).json());
/** One turn; the gateway request it produced, or null. */
async function turn(c, session, text) {
  const before = gw.seen.length;
  const res = await c.fetch(`/kortix/runtime/sessions/${rootIdOf(session)}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text }] }),
  });
  await c.drain();
  const reply = (await (await c.fetch(`/session/${rootIdOf(session)}/message`)).json())
    .filter((m) => m.info.role === "assistant").at(-1)?.parts.find((p) => p.type === "text")?.text ?? null;
  return { status: res.status, sent: gw.seen.slice(before).at(-1)?.body ?? null, reply };
}

// ── what the cell can see ───────────────────────────────────────────────────
let s = await listed();
check("GET /skill finds the workspace's skills — OpenCode's own route, the one the SDK calls",
  s.length === 2 && s.map((k) => k.name).sort().join(",") === "deploy,review" && s.every((k) => typeof k.description === "string" && k.description),
  JSON.stringify(s).slice(0, 160));
check("each one names where it lives as an absolute path the model could hand to a tool",
  s.every((k) => k.location.startsWith("/workspace/") && k.location.endsWith("/SKILL.md")), JSON.stringify(s.map((k) => k.location)));
let loaded = await cell.cell.skills();
check("the skills directories are resolved to absolute paths", loaded.dirs.length > 0 && loaded.dirs.every((d) => d.startsWith("/")), JSON.stringify(loaded.dirs));
check("a clean workspace produces no diagnostics", (loaded.diagnostics ?? []).length === 0, JSON.stringify(loaded.diagnostics));

// ── what reaches the model ──────────────────────────────────────────────────
// The prompt carries name, description and location. NOT the content: a skill
// is read by the model when it is relevant, and putting bodies in the prompt
// would bill every turn for every skill.
check("the system prompt block names each skill and where it lives",
  loaded.block.includes("deploy") && loaded.block.includes("How to ship") && loaded.block.includes("SKILL.md"),
  loaded.block.slice(0, 120));
check("THE SKILL BODIES ARE NOT IN THE BLOCK — only the model's read tool pulls those",
  !loaded.block.includes("Run deploy.sh") && !loaded.block.includes("append-only"), loaded.block.slice(0, 200));
check("with no skills the prompt is returned untouched, with no empty block",
  withSkills("BASE", "") === "BASE" && withSkills("BASE", "X") === "BASE\n\nX");
let t = await turn(cell, SESSION, "hello");
const sys = systemPromptOf(t.sent);
check("and the model RECEIVES that block in its system prompt — names, descriptions, locations",
  t.status === 202 && sys.includes("How to ship this service to dev") && sys.includes("The review checklist") && sys.includes("/workspace/.pi/skills/deploy/SKILL.md"),
  `${t.status} ${sys.slice(0, 200)}`);
check("but not one skill body", !sys.includes("Run deploy.sh") && !sys.includes("append-only"), "");

// ── a reload really re-reads ────────────────────────────────────────────────
// The trap: a cached load answered forever. The cell caches what it read (the
// prompt path reads skills on every prompt), and the control plane's
// `POST /kortix/refresh` is what re-reads.
await skillFile("deploy", "deploy", "CHANGED - ship it to production", "Run deploy.sh, then verify /health.");
const cached = await listed();
check("without a reload the cell serves what it already had",
  cached.find((k) => k.name === "deploy").description === "How to ship this service to dev",
  JSON.stringify(cached.find((k) => k.name === "deploy")));
const refreshed = await cell.fetch("/kortix/refresh", { method: "POST" });
const reloaded = await listed();
check("POST /kortix/refresh RE-READS THE FILE rather than serving the cached load",
  refreshed.status === 200 && reloaded.find((k) => k.name === "deploy").description === "CHANGED - ship it to production",
  JSON.stringify(reloaded.find((k) => k.name === "deploy")));
t = await turn(cell, SESSION, "again");
check("and the next turn's system prompt carries the re-read description",
  systemPromptOf(t.sent).includes("CHANGED - ship it to production") && !systemPromptOf(t.sent).includes("How to ship this service to dev"), "");

// ── a broken skill is reported, not fatal ───────────────────────────────────
await tree().writeFile(".pi/skills/bad/SKILL.md", "---\nname:\ndescription:\n---\n\nnothing valid here\n");
await cell.fetch("/kortix/refresh", { method: "POST" });
const withBad = await cell.cell.skills();
check("a skill with invalid metadata is skipped and reported, not silently absent",
  (withBad.diagnostics ?? []).length >= 1, JSON.stringify(withBad.diagnostics).slice(0, 160));
check("and the good skills still load alongside it", (await listed()).length === 2, JSON.stringify((await listed()).map((k) => k.name)));

// ── a turn still runs when skills are broken ────────────────────────────────
t = await turn(cell, SESSION, "hello with a broken skill present");
check("a turn runs with a broken skills directory present", t.status === 202 && t.reply === "ok", JSON.stringify({ status: t.status, reply: t.reply }));

// ── a missing skills directory is normal ────────────────────────────────────
{
  const bare = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s2", SKILLS_DIR: ".pi/does-not-exist" });
  await bare.fetch("/kortix/health");
  const none = await bare.cell.skills();
  check("a workspace with no skills directory loads zero skills without erroring",
    none.skills.length === 0 && (none.diagnostics ?? []).length === 0 && (await listed(bare)).length === 0, JSON.stringify(none).slice(0, 140));
  const ran = await turn(bare, "s2", "hi");
  check("and a turn runs normally there", ran.status === 202 && ran.reply === "ok", JSON.stringify({ status: ran.status, reply: ran.reply }));
}
await gw.close();

// ── a cell with skills switched off builds nothing ─────────────────────────
// loadWorkspaceSkills runs on every prompt. SKILLS_DIR="" is how a deployment
// says "this cell has no skills", and the early return is what stops it
// building an ExecutionEnv anyway — on an attached machine that is a remote
// client spent on a lookup that was always going to be empty.
//
// The answer is the same either way, so the claim is about whether the env
// factory was CALLED.
{
  const env = () => tree();
  let built = 0;
  const factory = () => { built++; return env(); };
  const off = await loadWorkspaceSkills({ SKILLS_DIR: "" }, factory);
  check("SKILLS_DIR=\"\" yields no skills and no directories",
    off.skills.length === 0 && off.dirs.length === 0, JSON.stringify(off).slice(0, 100));
  check("and NO execution env is built for it — every prompt would otherwise pay for a lookup that cannot find anything",
    built === 0, `${built} env(s) built`);
  // The default is NOT off: an env with nothing set looks in BOTH conventions
  // — a Kortix project keeps its skills in `.kortix/opencode/skills` and pi's
  // own are `.pi/skills` — so the branch above is a deliberate switch rather
  // than the common path.
  const byDefault = await loadWorkspaceSkills({}, factory);
  check("while the default configuration looks in both skill directories",
    byDefault.dirs.length === 2 && byDefault.dirs.some((d) => d.includes(".kortix/opencode/skills"))
      && byDefault.dirs.some((d) => d.includes(".pi/skills")) && built === 1,
    `${built} env(s) built, dirs ${JSON.stringify(byDefault.dirs)}`);

  // A directory that is ALREADY absolute needs no resolving. The answer is the
  // same either way — absolutePath hands an absolute path back unchanged — so
  // what moves is a round trip through the workspace, per directory, per prompt.
  let resolves = 0;
  const counting = () => {
    const e = env();
    return { ...e, absolutePath: (p, ctx) => { resolves++; return e.absolutePath(p, ctx); } };
  };
  const abs = await loadWorkspaceSkills({ SKILLS_DIR: "/tmp/skills-abs-a,/tmp/skills-abs-b" }, counting);
  check("an absolute skills directory is used as-is, with no round trip to resolve it",
    resolves === 0, `${resolves} absolutePath call(s) for ${JSON.stringify(abs.dirs)}`);
  check("and both of them come back as the absolute paths they were",
    JSON.stringify(abs.dirs) === JSON.stringify(["/tmp/skills-abs-a", "/tmp/skills-abs-b"]), JSON.stringify(abs.dirs));
  const relDir = await loadWorkspaceSkills({ SKILLS_DIR: "some/relative" }, counting);
  check("while a relative one IS resolved, once, against the workspace",
    resolves === 1 && relDir.dirs[0] === "/workspace/some/relative", `${resolves} call(s), ${JSON.stringify(relDir.dirs)}`);
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  skills come from the workspace: ${claims} claims`);
process.exit(bad ? 1 : 0);
