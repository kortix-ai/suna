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
// The directories are kortixd's (harness/pi/config.ts
// `resolvePiSkillDirectories`): the managed overlay, `skills/`, pi's config dir,
// the legacy `.kortix/opencode/skills`; the first one wins a name. Slash
// commands are pi prompt templates from `<pi config dir>/prompts`, and
// `/skill:name` expands the skill into the prompt, as pi's AgentSession does.
// EXPECTED_PASSES=44

import { installWorkerGlobals, makeCell, newMessageId, rootIdOf } from "./cell-harness.mjs";
import { createServer } from "node:http";
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
  tree().writeFile(`skills/${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);
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
  t.status === 202 && sys.includes("How to ship this service to dev") && sys.includes("The review checklist") && sys.includes("/workspace/skills/deploy/SKILL.md"),
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
await tree().writeFile("skills/bad/SKILL.md", "---\nname:\ndescription:\n---\n\nnothing valid here\n");
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
  const bare = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s2", SKILLS_DIR: "skills/does-not-exist" });
  await bare.fetch("/kortix/health");
  const none = await bare.cell.skills();
  check("a workspace with no skills directory loads zero skills without erroring",
    none.skills.length === 0 && (none.diagnostics ?? []).length === 0 && (await listed(bare)).length === 0, JSON.stringify(none).slice(0, 140));
  const ran = await turn(bare, "s2", "hi");
  check("and a turn runs normally there", ran.status === 202 && ran.reply === "ok", JSON.stringify({ status: ran.status, reply: ran.reply }));
}

// ── kortixd's directories, and the first one wins a name ────────────────────
await tree().writeFile("harnesses/pi/skills/pi-only/SKILL.md", "---\nname: pi-only\ndescription: Only in pi's config dir\n---\n\nPI BODY\n");
await tree().writeFile(".kortix/opencode/skills/legacy/SKILL.md", "---\nname: legacy\ndescription: An OpenCode-era skill\n---\n\nLEGACY BODY\n");
await tree().writeFile(".kortix/opencode/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: LEGACY COPY of deploy\n---\n\nold\n");
await cell.fetch("/kortix/refresh", { method: "POST" });
s = await listed();
const names = s.map((k) => k.name).sort().join(",");
check("skills come from skills/, harnesses/pi/skills and .kortix/opencode/skills together",
  names === "deploy,legacy,pi-only,review", names);
check("a name in two directories is the EARLIER directory's: skills/ beats the legacy copy",
  s.find((k) => k.name === "deploy").location === "/workspace/skills/deploy/SKILL.md" && !JSON.stringify(s).includes("LEGACY COPY"),
  JSON.stringify(s.find((k) => k.name === "deploy")));
check("and the shadowed copy is reported as a collision, not dropped silently",
  (await cell.cell.skills()).diagnostics.some((d) => d.type === "collision" && d.path.includes(".kortix/opencode/skills/deploy")),
  JSON.stringify((await cell.cell.skills()).diagnostics).slice(0, 200));

// ── /skill:name puts the skill in the prompt, as pi does ───────────────────
const lastUserText = (body) => {
  const m = (body?.messages ?? []).filter((x) => x.role === "user").at(-1);
  return !m ? "" : typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c?.text ?? "").join("");
};
t = await turn(cell, SESSION, "/skill:deploy to staging please");
check("`/skill:deploy args` sends the model the skill body in a <skill> block, then the arguments",
  t.status === 202 && lastUserText(t.sent).startsWith('<skill name="deploy" location="/workspace/skills/deploy/SKILL.md">')
    && lastUserText(t.sent).includes("Run deploy.sh") && lastUserText(t.sent).endsWith("to staging please"),
  lastUserText(t.sent).slice(0, 200));
t = await turn(cell, SESSION, "/skill:nope hi");
check("an unknown /skill: passes through unchanged", lastUserText(t.sent) === "/skill:nope hi", lastUserText(t.sent));

// ── slash commands: pi prompt templates from harnesses/pi/prompts ───────────
await tree().writeFile("harnesses/pi/prompts/fix.md", "---\ndescription: Fix an issue\nargument-hint: <id> <area>\n---\nFix issue $1 in $2. All: $ARGUMENTS\n");
await tree().writeFile("harnesses/pi/prompts/plain.md", "Summarise the repository in three lines.\n");
await cell.fetch("/kortix/refresh", { method: "POST" });
const commands = await (await cell.fetch("/command")).json();
check("GET /command lists the templates in kortixd's shape",
  commands.length === 2 && commands[0].name === "fix" && commands[0].description === "Fix an issue" && commands[0].source === "command"
    && JSON.stringify(commands[0].hints) === JSON.stringify(["$1", "$2", "$ARGUMENTS"]),
  JSON.stringify(commands).slice(0, 240));
check("a template with no description takes its first line", commands[1].name === "plain" && commands[1].description === "Summarise the repository in three lines.", JSON.stringify(commands[1]));
const health = await (await cell.fetch("/kortix/health")).json();
check("the cell advertises session.commands", health.capabilities.includes("session.commands"), JSON.stringify(health.capabilities));
{
  const before = gw.seen.length;
  const pending = cell.fetch(`/session/${rootIdOf(SESSION)}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "fix", arguments: '42 "the parser"' }) });
  await cell.drain();
  const res = await pending;
  const sent = gw.seen.slice(before).at(-1)?.body;
  check("POST /session/:id/command runs the template with quoted arguments substituted",
    res.status === 200 && lastUserText(sent) === "Fix issue 42 in the parser. All: 42 the parser", `${res.status} ${lastUserText(sent)}`);
  const users = (await (await cell.fetch(`/session/${rootIdOf(SESSION)}/message`)).json()).filter((m) => m.info.role === "user");
  check("and the user message shows the expanded text, as kortixd's pi does",
    users.at(-1)?.parts.find((p) => p.type === "text")?.text === "Fix issue 42 in the parser. All: 42 the parser", JSON.stringify(users.at(-1)?.parts).slice(0, 200));
}
{
  const res = await cell.fetch(`/session/${rootIdOf(SESSION)}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "nope" }) });
  check("an unknown command is 400 with kortixd's message", res.status === 400 && (await res.json()).error === 'unknown command "nope"', String(res.status));
}
t = await turn(cell, SESSION, "/fix 7 lexer");
check("a typed `/fix 7 lexer` prompt expands too", lastUserText(t.sent) === "Fix issue 7 in lexer. All: 7 lexer", lastUserText(t.sent));

// ── the agent's skill grant ────────────────────────────────────────────────
{
  const config = JSON.stringify({ agent: { kortix: { prompt: "P", permission: { skill: { review: "deny", "*": "allow" } } } } });
  const granted = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s3", KORTIX_COMPILED_AGENT_CONFIG: config, KORTIX_AGENT_NAME: "kortix" });
  await granted.fetch("/kortix/health");
  const gtree = cellExecutionEnv(granted.cell.cell());
  await gtree.writeFile("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship it\n---\n\nbody\n");
  await gtree.writeFile("skills/review/SKILL.md", "---\nname: review\ndescription: Review it\n---\n\nbody\n");
  const seen = (await (await granted.fetch("/skill")).json()).map((k) => k.name).join(",");
  check("a skill the agent's `permission.skill` denies is not listed", seen === "deploy", seen);
  const g = await turn(granted, "s3", "hi");
  check("and not offered in the system prompt", systemPromptOf(g.sent).includes("Ship it") && !systemPromptOf(g.sent).includes("Review it"), systemPromptOf(g.sent).slice(-300));
}

// ── the managed overlay ─────────────────────────────────────────────────────
{
  const asked = [];
  const overlay = { hash: "h1", files: [
    { path: "kortix-system/SKILL.md", content: "---\nname: kortix-system\ndescription: MANAGED copy\n---\n\nmanaged body\n" },
    { path: "../escape/SKILL.md", content: "---\nname: escape\ndescription: x\n---\n" },
  ] };
  const api = createServer((req, res) => {
    asked.push({ url: req.url, auth: req.headers.authorization ?? null, inm: req.headers["if-none-match"] ?? null });
    if (req.headers["if-none-match"] === `"${overlay.hash}"`) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", etag: `"${overlay.hash}"` });
    res.end(JSON.stringify(overlay));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${api.address().port}/v1`;
  const managed = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s4", KORTIX_API_URL: apiUrl });
  await managed.fetch("/kortix/health");
  await cellExecutionEnv(managed.cell.cell()).writeFile("skills/kortix-system/SKILL.md", "---\nname: kortix-system\ndescription: PROJECT copy\n---\n\nproject body\n");
  const ms = await (await managed.fetch("/skill")).json();
  const sys = ms.find((k) => k.name === "kortix-system");
  check("a cell fetches the managed overlay from /v1/runtime-assets/managed-skills with its token",
    asked.length === 1 && asked[0].url === "/v1/runtime-assets/managed-skills" && asked[0].auth === "Bearer tok-skills", JSON.stringify(asked));
  check("and the managed copy of a kortix-* skill wins over the project's, at kortixd's path",
    sys?.description === "MANAGED copy" && sys?.location === "/opt/kortix/managed-skills/kortix-system/SKILL.md", JSON.stringify(sys));
  check("an overlay path that climbs out with .. is not written", !ms.some((k) => k.name === "escape"), JSON.stringify(ms.map((k) => k.name)));
  await managed.fetch("/kortix/refresh", { method: "POST" });
  check("a reload inside the overlay's TTL asks the API nothing", asked.length === 1, JSON.stringify(asked));
  // A new isolate on the same storage: the overlay comes back from SQLite.
  const again = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s4", KORTIX_API_URL: apiUrl }, { db: managed.db });
  await again.fetch("/kortix/health");
  const back = (await (await again.fetch("/skill")).json()).find((k) => k.name === "kortix-system");
  check("a new isolate re-materialises the overlay from SQLite without a request", back?.description === "MANAGED copy" && asked.length === 1, `${JSON.stringify(back)} ${asked.length}`);
  api.close();
}
{
  const failing = makeCell(AgentCell, { ...ENV, KORTIX_SESSION_ID: "s5", KORTIX_API_URL: "http://127.0.0.1:9/v1" });
  await failing.fetch("/kortix/health");
  await cellExecutionEnv(failing.cell.cell()).writeFile("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship it\n---\n\nbody\n");
  const fs5 = (await (await failing.fetch("/skill")).json()).map((k) => k.name).join(",");
  check("an unreachable API leaves the project's skills working", fs5 === "deploy", fs5);
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
  // The default is NOT off: with nothing set it reads kortixd's directories,
  // in kortixd's order, so the branch above is a deliberate switch.
  const byDefault = await loadWorkspaceSkills({}, factory);
  check("while the default reads kortixd's directories in kortixd's order: managed, skills/, legacy",
    JSON.stringify(byDefault.dirs) === JSON.stringify(["/opt/kortix/managed-skills", "/workspace/skills", "/workspace/.kortix/opencode/skills"]) && built === 1,
    `${built} env(s) built, dirs ${JSON.stringify(byDefault.dirs)}`);
  const withPi = await loadWorkspaceSkills({}, factory, "harnesses/pi");
  check("and pi's config dir sits between skills/ and the legacy dir",
    JSON.stringify(withPi.dirs) === JSON.stringify(["/opt/kortix/managed-skills", "/workspace/skills", "/workspace/harnesses/pi/skills", "/workspace/.kortix/opencode/skills"]),
    JSON.stringify(withPi.dirs));

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
