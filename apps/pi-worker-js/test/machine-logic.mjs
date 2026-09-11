// THE `machine` TOOL, from the model's side.
//
// One tool, four actions. What the model must get back: a command's output
// and exit code from a machine that was attached on the first call and kept;
// a plain sentence when there is no machine and why; files that moved by
// path, in either direction, with the ones that could not named. And what
// must NOT happen: a second attach for a second call, a run with no command
// silently doing nothing, output big enough to spend the model's context.
//
// Fake attach, fake machine, fake workspace — the tool is pure over them.
// EXPECTED_PASSES=19
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { machineTool, runSummary, MACHINE_ACTIONS, MACHINE_OUTPUT_MAX, MACHINE_DEFAULT_TIMEOUT_S, MACHINE_MAX_TIMEOUT_S } = await import("../src/machine-tool.js");

const ok = (value) => ({ ok: true, value });
const err = (message, code = "unknown") => ({ ok: false, error: { code, message } });
const textOf = (r) => r.content.map((c) => c.text).join("\n");

/** A fake ExecutionEnv over a map of files, recording execs. */
function fakeEnv(files = {}) {
  const execs = [];
  return {
    files, execs,
    exec: async (command, options) => { execs.push({ command, options }); return ok({ stdout: `out:${command}`, stderr: "", exitCode: 0 }); },
    readBinaryFile: async (p) => (p in files ? ok(new TextEncoder().encode(files[p])) : err(`no such file: ${p}`, "not_found")),
    writeFile: async (p, content) => { files[p] = new TextDecoder().decode(content); return ok(undefined); },
    createDir: async () => ok(undefined),
  };
}

// ── the shape the model reads ──
check("the tool is named machine, takes an action, and the actions are exactly run, push, pull, status",
  machineTool({ attach: async () => ({ ok: false }), envFor: async () => null, workspace: () => null }).name === "machine"
    && JSON.stringify(MACHINE_ACTIONS) === JSON.stringify(["run", "push", "pull", "status"]), "");
check("a run summary carries stdout, stderr marked as such, and the exit code",
  runSummary({ stdout: "hi\n", stderr: "warn\n", exitCode: 3 }) === "hi\n\n[stderr]\nwarn\n\n[exit 3]"
    && runSummary({ stdout: "", stderr: "", exitCode: 0 }) === "[exit 0]", JSON.stringify(runSummary({ stdout: "hi\n", stderr: "warn\n", exitCode: 3 })));
check("and output past the cap is cut, and says so — the daemon allows 2 MiB per stream and the model does not",
  /output cut at/.test(runSummary({ stdout: "x".repeat(MACHINE_OUTPUT_MAX + 10), stderr: "", exitCode: 0 })), "");

// ── attach once, run many ──
{
  let attaches = 0;
  const machine = fakeEnv();
  const tool = machineTool({
    attach: async () => { attaches++; return { ok: true, externalId: "sbx_m", edge: "https://8000-m.sbx", rpcSecret: "s" }; },
    envFor: async () => machine,
    workspace: () => fakeEnv(),
  });
  const before = await tool.execute("1", { action: "status" });
  check("status before any run says no machine is attached yet, without attaching one", /no machine attached/.test(textOf(before)) && attaches === 0, textOf(before));
  const r1 = await tool.execute("2", { action: "run", command: "node -v" });
  check("the first run attaches the machine and runs the command there", attaches === 1 && textOf(r1) === "out:node -v\n[exit 0]" && r1.exitCode === 0, textOf(r1));
  await tool.execute("3", { action: "run", command: "pnpm i", cwd: "/workspace/app", timeout: 30 });
  check("a second run does NOT attach again", attaches === 1, String(attaches));
  check("cwd and timeout reach the machine; the timeout is in seconds, pi's unit",
    machine.execs[1].options.cwd === "/workspace/app" && machine.execs[1].options.timeout === 30, JSON.stringify(machine.execs[1].options));
  await tool.execute("4", { action: "run", command: "x" });
  check("a run with no timeout gets the default, and one past the ceiling is clamped",
    machine.execs[2].options.timeout === MACHINE_DEFAULT_TIMEOUT_S
      && (await tool.execute("5", { action: "run", command: "y", timeout: 99999 }), machine.execs[3].options.timeout === MACHINE_MAX_TIMEOUT_S), "");
  const after = await tool.execute("6", { action: "status" });
  check("status after says which box, and where", /attached: sbx_m at https:\/\/8000-m\.sbx/.test(textOf(after)), textOf(after));
  const empty = await tool.execute("7", { action: "run", command: "   " });
  check("a run with no command is refused in words, not run as an empty string", /needs a command/.test(textOf(empty)) && machine.execs.length === 4, textOf(empty));
  const unknown = await tool.execute("8", { action: "teleport" });
  check("an unknown action lists the ones there are", /unknown action "teleport"/.test(textOf(unknown)) && /run, push, pull, status/.test(textOf(unknown)), textOf(unknown));
}

// ── no machine ──
{
  const tool = machineTool({ attach: async () => ({ ok: false, reason: "the control plane could not provision a machine for this session" }), envFor: async () => null, workspace: () => fakeEnv() });
  const r = await tool.execute("1", { action: "run", command: "ls" });
  check("when no machine can be attached the model is told so, with the reason, and nothing runs", /^no machine: the control plane could not/.test(textOf(r)), textOf(r));
}

// ── a machine that dies is re-attached on the next call ──
{
  let attaches = 0; let dead = true;
  const machine = { exec: async () => dead ? err("fetch failed: ECONNREFUSED") : ok({ stdout: "alive", stderr: "", exitCode: 0 }) };
  const tool = machineTool({ attach: async () => { attaches++; return { ok: true, externalId: `sbx_${attaches}`, edge: "https://e", rpcSecret: "s" }; }, envFor: async () => machine, workspace: () => fakeEnv() });
  const r1 = await tool.execute("1", { action: "run", command: "ls" });
  check("a machine error is reported as such", /^machine error: fetch failed/.test(textOf(r1)), textOf(r1));
  dead = false;
  const r2 = await tool.execute("2", { action: "run", command: "ls" });
  check("and an UNREACHABLE machine is dropped, so the next call re-attaches (the control plane resumes or rebuilds it)", attaches === 2 && textOf(r2).startsWith("alive"), `${attaches} ${textOf(r2)}`);
}

// ── push and pull ──
{
  const ws = fakeEnv({ "src/a.js": "A", "README.md": "R" });
  const machine = fakeEnv({ "dist/out.js": "O" });
  const tool = machineTool({ attach: async () => ({ ok: true, externalId: "m", edge: "https://e", rpcSecret: "s" }), envFor: async () => machine, workspace: () => ws });
  const pushed = await tool.execute("1", { action: "push", paths: ["src/a.js", "/workspace/README.md", "missing.txt"] });
  check("push copies the named workspace files into the machine, strips a /workspace prefix, and names the ones it could not read",
    machine.files["src/a.js"] === "A" && machine.files["README.md"] === "R" && /pushed 2 file\(s\) into the machine/.test(textOf(pushed)) && /failed missing\.txt: no such file/.test(textOf(pushed)),
    textOf(pushed));
  const pulled = await tool.execute("2", { action: "pull", paths: ["dist/out.js"] });
  check("pull copies machine files back into the workspace", ws.files["dist/out.js"] === "O" && /pulled 1 file\(s\) back into the workspace/.test(textOf(pulled)), textOf(pulled));
  const none = await tool.execute("3", { action: "push", paths: [] });
  check("push or pull with no paths is refused in words", /push needs paths/.test(textOf(none)), textOf(none));
  check("bytes move as bytes — a push round-trips exactly", machine.files["src/a.js"] === ws.files["src/a.js"], "");
}
{
  // The tool's own text never claims a copy that did not happen.
  const ws = fakeEnv({});
  const tool = machineTool({ attach: async () => ({ ok: true, externalId: "m", edge: "https://e", rpcSecret: "s" }), envFor: async () => fakeEnv(), workspace: () => ws });
  const r = await tool.execute("1", { action: "push", paths: ["nope"] });
  check("when nothing could be copied it says `nothing pushed`, with each failure", /^nothing pushed/.test(textOf(r)) && /failed nope/.test(textOf(r)), textOf(r));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
