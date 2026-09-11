// THE `machine` TOOL: A REAL LINUX MACHINE, ONE CALL AWAY.
//
// The cell tells the model one thing about its own shell — that it is a small
// POSIX shell over the session's tree with no runtimes — and one thing about
// the way out: this tool. The first call attaches the session's environment
// (environment.js); every call runs a command in it, over the same RPC the
// production worker uses (execenv.envrpc.js). Files move in both directions
// by path, so the model can build in the machine and keep the result in the
// workspace, or the other way round.
//
// Deliberately ONE tool with an `action`, not four: a picker with a dozen
// entries is where models reach for the wrong one. `run` is the whole point;
// `push`/`pull` exist because two trees exist; `status` exists so the model can
// tell the user what it is waiting for instead of guessing.
//
// Pure over what it is handed — `attach()` and `envFor(record)` — so every
// shape is asserted without a control plane or a box.
import { Type } from "typebox";

export const MACHINE_ACTIONS = ["run", "push", "pull", "status"];
/** The daemon caps each stream at 2 MiB; what reaches the model is capped lower. */
export const MACHINE_OUTPUT_MAX = 60_000;
export const MACHINE_DEFAULT_TIMEOUT_S = 120;
export const MACHINE_MAX_TIMEOUT_S = 600;

const text = (s) => ({ content: [{ type: "text", text: s }] });

function clip(s, max = MACHINE_OUTPUT_MAX) {
  const str = String(s ?? "");
  return str.length > max ? `${str.slice(0, max)}\n[output cut at ${max} characters]` : str;
}

/** What the model reads back from a `run`. */
export function runSummary({ stdout, stderr, exitCode }) {
  const parts = [];
  if (stdout) parts.push(clip(stdout));
  if (stderr) parts.push(`[stderr]\n${clip(stderr)}`);
  parts.push(`[exit ${exitCode}]`);
  return parts.join("\n");
}

/**
 * @param {object} o
 * @param {() => Promise<{ok:boolean, edge?:string, externalId?:string, reason?:string, resumed?:boolean}>} o.attach
 * @param {(record) => Promise<object>} o.envFor        the machine's ExecutionEnv for an attached record
 * @param {() => object} o.workspace                   the cell's own ExecutionEnv (for push/pull)
 * @param {(line:string) => void} [o.onProgress]
 */
export function machineTool({ attach, envFor, workspace, onProgress }) {
  let machine = null;   // { record, env }

  async function ready() {
    if (machine) return machine;
    const r = await attach();
    if (!r.ok) return { error: r.reason };
    machine = { record: r, env: await envFor(r) };
    return machine;
  }

  return {
    name: "machine",
    label: "Machine",
    description: [
      "A full Linux machine for this session: node, pnpm, bun, python, git, package installs, builds, dev servers — everything the workspace shell cannot do.",
      "Attached on first use (about ten seconds) and kept for the session. The project is checked out on it at /workspace on this session's branch.",
      "action=run executes a shell command there (cwd defaults to /workspace). action=push copies files from the workspace into the machine; action=pull copies them back. action=status says whether a machine is attached.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String({ description: "run | push | pull | status" }),
      command: Type.Optional(Type.String({ description: "For run: the shell command." })),
      cwd: Type.Optional(Type.String({ description: "For run: working directory on the machine. Default /workspace." })),
      timeout: Type.Optional(Type.Number({ description: `For run: seconds before the command is killed. Default ${MACHINE_DEFAULT_TIMEOUT_S}, max ${MACHINE_MAX_TIMEOUT_S}.` })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "For push/pull: file paths relative to /workspace." })),
    }),
    async execute(_id, args, signal) {
      const action = String(args?.action ?? "").trim();
      if (!MACHINE_ACTIONS.includes(action)) return text(`unknown action "${action}". Use one of: ${MACHINE_ACTIONS.join(", ")}.`);
      if (action === "status") {
        if (machine) return text(`attached: ${machine.record.externalId} at ${machine.record.edge}`);
        return text("no machine attached yet. It is attached on the first run/push/pull.");
      }
      const m = await ready();
      if (m.error) return text(`no machine: ${m.error}`);
      if (action === "run") {
        const command = String(args?.command ?? "").trim();
        if (!command) return text("run needs a command.");
        const timeout = Math.min(Math.max(Number(args?.timeout) || MACHINE_DEFAULT_TIMEOUT_S, 1), MACHINE_MAX_TIMEOUT_S);
        onProgress?.(`machine: ${command.slice(0, 80)}`);
        const r = await m.env.exec(command, { cwd: args?.cwd || undefined, timeout, abortSignal: signal });
        if (!r.ok) {
          // A dead box is the one failure worth a second attach: the record is
          // dropped so the next call re-asks the control plane, which resumes
          // or rebuilds it.
          if (/unreachable|fetch failed|ECONN|socket/i.test(String(r.error?.message ?? ""))) machine = null;
          return text(`machine error: ${r.error?.message ?? "exec failed"}`);
        }
        return { ...text(runSummary(r.value)), exitCode: r.value.exitCode };
      }
      const paths = Array.isArray(args?.paths) ? args.paths.map((p) => String(p).replace(/^\/+/, "").replace(/^workspace\//, "")).filter(Boolean) : [];
      if (!paths.length) return text(`${action} needs paths.`);
      const from = action === "push" ? workspace() : m.env;
      const to = action === "push" ? m.env : workspace();
      const done = [];
      const failed = [];
      for (const p of paths) {
        const read = await from.readBinaryFile(p);
        if (!read.ok) { failed.push(`${p}: ${read.error?.message ?? "read failed"}`); continue; }
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        if (dir) await to.createDir(dir, { recursive: true });
        const write = await to.writeFile(p, read.value);
        if (!write.ok) { failed.push(`${p}: ${write.error?.message ?? "write failed"}`); continue; }
        done.push(p);
      }
      const where = action === "push" ? "into the machine" : "back into the workspace";
      return text([done.length ? `${action}ed ${done.length} file(s) ${where}: ${done.join(", ")}` : `nothing ${action}ed`, ...failed.map((f) => `failed ${f}`)].join("\n"));
    },
  };
}
