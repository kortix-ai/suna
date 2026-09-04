// LIST AND GREP, ONCE, FOR BOTH BACKENDS.
//
// pi's core tool set is bash/read/write/edit. Platinum serves list and grep
// natively, so the Platinum path had six tools and the daemon path had four —
// the model's abilities depended on which backend a deployment happened to use,
// which is the kind of difference nobody discovers until a prompt behaves
// differently in production than in a test.
//
// Both are written against the ExecutionEnv rather than against either backend,
// so there is ONE implementation with one behaviour. listDir is on the
// interface; grep is not, so it runs through the shell the env already exposes.
// That costs a process on Platinum, where a native /files/grep route exists —
// paid deliberately, because two implementations of "grep" that format results
// differently is worse than one that is occasionally slower.
import { Type } from "typebox";

const text = (s) => ({ content: [{ type: "text", text: s }] });

/** Shell-quote one argument. The pattern and path are the model's; never interpolate them raw. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function listTool() {
  return {
    name: "list",
    label: "List directory",
    description: "List the entries of a directory in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list. Defaults to the working directory." })),
    }),
    execute: async (_id, { path }, _signal, _onUpdate, ctx) => {
      const r = await ctx.env.listDir(path ?? ".");
      if (!r.ok) throw new Error(`list ${path ?? "."}: ${r.error?.message ?? r.error}`);
      const rows = r.value
        .map((e) => `${e.kind === "directory" ? "d" : "-"} ${e.name}`)
        .sort();
      return text(rows.join("\n") || "(empty)");
    },
  };
}

export function grepTool() {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents in the workspace.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Pattern to search for." }),
      path: Type.Optional(Type.String({ description: "Directory or file to search. Defaults to the working directory." })),
      max: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return." })),
    }),
    execute: async (_id, { pattern, path, max }, signal, _onUpdate, ctx) => {
      const where = path ?? ".";
      const limit = Math.max(1, Math.min(Number(max ?? 200), 2000));
      // -r recursive, -n line numbers, -I skip binaries, -- ends options so a
      // pattern beginning with a dash is a pattern and not a flag.
      const r = await ctx.env.exec(
        `grep -rnI -- ${q(pattern)} ${q(where)} 2>/dev/null | head -n ${limit}`,
        { abortSignal: signal },
      );
      if (!r.ok) throw new Error(`grep: ${r.error?.message ?? r.error}`);
      const out = String(r.value.stdout ?? "").trimEnd();
      // grep exits 1 when there are no matches. That is an ANSWER, not a
      // failure, and reporting it as an error would have the model retry a
      // search that already succeeded in telling it nothing is there.
      if (!out) return text("(no matches)");
      // Paths are made relative to the search root so the model sees the same
      // shape on both backends, whose absolute roots differ.
      const root = where.replace(/\/+$/, "");
      return text(out.split("\n").map((l) => (root && root !== "." ? l.replace(`${root}/`, "") : l.replace(/^\.\//, ""))).join("\n"));
    },
  };
}
