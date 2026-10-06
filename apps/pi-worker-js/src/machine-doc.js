// /MACHINE.md, FOR A CELL.
//
// A VM session bakes the platform's machine guide at /MACHINE.md
// (apps/sandbox/MACHINE.md), and the starter agent prompt tells the model to
// read it. A cell had no such file, and the starter prompt's "use pnpm, run
// python3" then contradicted the cell's own shell note: measured on pi-js
// 2026-10-06, the model spent its first turn arguing with itself about which
// one to believe. So a cell answers the same path with the truth about itself,
// generated from the same lists the shell is built from.
//
// It lives at / in the in-memory tree, which is never persisted
// (execenv.cell.js persists /workspace and /tmp only): every isolate writes it
// fresh, so it cannot drift from the code that serves it.
import { CELL_COMMANDS, CELL_MISSING } from "./execenv.cell.js";

export const MACHINE_DOC_PATH = "/MACHINE.md";

export function cellMachineDoc({ machine = false, tools = [] } = {}) {
  const missing = CELL_MISSING.filter((c) => !CELL_COMMANDS.includes(c));
  return [
    "# Kortix pi cell",
    "",
    "This session runs in a pi cell: an isolate on the Kortix edge, not a Linux machine.",
    "It starts in about a second and keeps the workspace between turns.",
    "This file replaces the machine guide a VM session has. Where the agent prompt says to use pnpm, python3 or uv, this file is what is true here.",
    "",
    "## Workspace",
    "",
    "The project repository is checked out at `/workspace`. Files there persist, and so do files in `/tmp`.",
    "Everything else resets when the cell restarts. Only what is committed and pushed leaves the session.",
    "",
    "## Shell",
    "",
    "The bash tool runs just-bash, a POSIX shell inside the isolate. Its commands:",
    "",
    CELL_COMMANDS.map((c) => `\`${c}\``).join(", "),
    "",
    "- `node` is a Node 22 runtime in the isolate: require, ESM, TypeScript, fs, path, crypto, zlib, fetch. There are no child processes, no sockets and no servers.",
    "- `npm install <pkg>` fetches packages into `node_modules`. Lifecycle scripts do not run.",
    "- `curl` and `wget` reach HTTP(S).",
    "- `git` works on the checkout: status, diff, log, show, add, commit, branch, restore, reset. It does not push, pull or fetch; Kortix pushes the session's commits.",
    `- Not here: ${missing.map((c) => `\`${c}\``).join(", ")}, and nothing that keeps running or listens on a port after a command ends.`,
    "",
    ...(tools.length ? ["## Tools", "", `Registered tools: ${tools.join(", ")}.`, ""] : []),
    "## When a task needs a real machine",
    "",
    machine
      ? "Use the `machine` tool. It attaches a full Linux environment with the project checked out and runs the command there."
      : "Python, native builds, a dev server, a database or a browser need a VM session. Say so plainly instead of working around it. A project chooses VM sessions with `sandbox.type: vm` in kortix.yaml.",
    "",
    "Project-specific instructions override this file.",
    "",
  ].join("\n");
}
