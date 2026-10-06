// GLOB AND TODOS — two tools the product's UI already knows how to draw.
//
// The web client renders a tool call by NAME (packages/sdk core/turns/
// view-model.ts `toolViewModel`): `glob` gets the search view, `todowrite`
// gets the checklist card the session panel shows as a plan. A cell offered
// neither, so a model working here could not lay out a plan the user could
// watch, and `GET /session/:id/todo` — which the client polls — answered an
// empty list forever.
//
// `glob` is written over the ExecutionEnv rather than shelling out to
// ripgrep (which is what kortix-worker does), because a cell's shell is
// just-bash: one implementation, one behaviour, both backends. `todowrite`
// stores the list in the cell's own SQLite, which is what makes the poll
// answerable after an eviction and across a reload.

import { Type } from "typebox";

const text = (s) => ({ content: [{ type: "text", text: s }] });

/** Directories a workspace walk never descends into. */
export const GLOB_SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".venv", "__pycache__"]);
const MAX_GLOB_FILES = 20_000;
const MAX_GLOB_RESULTS = 500;

/**
 * A glob as a regular expression, with the meanings a developer expects:
 * `**` crosses directories, `*` and `?` do not, `{a,b}` alternates, and a
 * pattern with no slash matches by BASENAME at any depth (`*.ts` finds
 * `src/a.ts`) — the rule ripgrep's `--glob` follows and the one a model
 * assumes.
 */
export function globToRegExp(pattern) {
  const p = String(pattern ?? "").trim();
  if (!p) return null;
  const anchoredToRoot = p.includes("/");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**/` may match nothing at all, so the slash after it is optional.
        i++;
        if (p[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") { out += "(?:"; }
    else if (ch === "}") { out += ")"; }
    else if (ch === ",") { out += "|"; }
    else if ("\\^$.|+()[]".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(anchoredToRoot ? `^${out}$` : `(?:^|/)${out}$`);
}

/** Every file under `dir`, relative to it, skipping what a workspace walk skips. */
export async function walkFiles(env, dir, limit = MAX_GLOB_FILES) {
  const out = [];
  const seen = new Set();
  async function walk(rel) {
    if (out.length >= limit) return;
    const listed = await env.listDir(rel || ".");
    if (!listed.ok) return;
    for (const entry of listed.value) {
      if (out.length >= limit) return;
      const name = entry.name;
      const next = rel ? `${rel}/${name}` : name;
      if (entry.kind === "directory") {
        if (GLOB_SKIP.has(name) || seen.has(next)) continue;
        seen.add(next);
        await walk(next);
      } else out.push(next);
    }
  }
  await walk(dir === "." || !dir ? "" : String(dir).replace(/^\.\//, "").replace(/\/+$/, ""));
  return out;
}

export function globTool() {
  return {
    name: "glob",
    label: "Glob",
    description: `Find files by glob pattern (**, *, ?, {a,b}). A pattern without a slash matches by file name at any depth. Sorted by path, up to ${MAX_GLOB_RESULTS} results.`,
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts or src/**/index.*" }),
      path: Type.Optional(Type.String({ description: "Directory to search under. Defaults to the working directory." })),
    }),
    execute: async (_id, { pattern, path }, _signal, _onUpdate, ctx) => {
      const re = globToRegExp(pattern);
      if (!re) throw new Error("glob: a pattern is required");
      const base = path ? String(path).replace(/^\.\//, "").replace(/\/+$/, "") : "";
      // walkFiles answers paths relative to the WORKSPACE, base included, so
      // they are already what a reader can paste into a read tool.
      const files = await walkFiles(ctx.env, base);
      const hits = files.filter((f) => re.test(f)).sort();
      const shown = hits.slice(0, MAX_GLOB_RESULTS);
      const body = shown.join("\n");
      return text(hits.length === 0
        ? "No files found"
        : hits.length > shown.length
          ? `${body}\n… ${hits.length - shown.length} more`
          : body);
    },
  };
}

// ── Todos ────────────────────────────────────────────────────────────────
/** The statuses OpenCode's checklist knows. Anything else is stored as pending. */
export const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

/** One todo, in the shape the client's `TodoItem` reads (content/status/priority). */
export function normalizeTodo(raw, index = 0) {
  const t = raw && typeof raw === "object" ? raw : {};
  const status = typeof t.status === "string" && TODO_STATUSES.has(t.status.trim()) ? t.status.trim() : "pending";
  const content = typeof t.content === "string" ? t.content.trim() : typeof t === "string" ? String(t).trim() : "";
  return {
    id: typeof t.id === "string" && t.id.trim() ? t.id.trim() : String(index + 1),
    content,
    status,
    ...(typeof t.priority === "string" && t.priority.trim() ? { priority: t.priority.trim() } : {}),
  };
}

/** A whole list, filtered of empties — a todo with no text is not a todo. */
export function normalizeTodos(raw) {
  return (Array.isArray(raw) ? raw : []).map((t, i) => normalizeTodo(t, i)).filter((t) => t.content);
}

/** Read the stored list. Empty until the model writes one. */
export function readTodos(sql) {
  try {
    sql.exec("CREATE TABLE IF NOT EXISTS todos (i INTEGER PRIMARY KEY CHECK (i = 1), json TEXT NOT NULL, ts INTEGER NOT NULL)");
    const row = sql.exec("SELECT json FROM todos WHERE i = 1").toArray()[0];
    return row ? normalizeTodos(JSON.parse(row.json)) : [];
  } catch {
    return [];
  }
}

/** Replace it. The whole list every time — that is what `todowrite` means. */
export function writeTodos(sql, todos) {
  const list = normalizeTodos(todos);
  sql.exec("CREATE TABLE IF NOT EXISTS todos (i INTEGER PRIMARY KEY CHECK (i = 1), json TEXT NOT NULL, ts INTEGER NOT NULL)");
  sql.exec(
    "INSERT INTO todos(i, json, ts) VALUES (1, ?, ?) ON CONFLICT(i) DO UPDATE SET json = excluded.json, ts = excluded.ts",
    JSON.stringify(list), Date.now(),
  );
  return list;
}

const todoSummary = (list) => list.length === 0
  ? "The todo list is empty."
  : list.map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]"} ${t.content}`).join("\n");

/**
 * `todowrite` and `todoread`. The write REPLACES the list, which is the
 * contract every OpenCode client renders against — the card shows the list
 * the model last wrote, not an append log — and `onWrite` lets the worker
 * tell the browser it changed.
 */
export function todoTools(sql, onWrite) {
  const todo = Type.Object({
    content: Type.String({ description: "What the step is." }),
    status: Type.Optional(Type.String({ description: "pending | in_progress | completed | cancelled" })),
    priority: Type.Optional(Type.String({ description: "high | medium | low" })),
    id: Type.Optional(Type.String()),
  });
  return [
    {
      name: "todowrite",
      label: "Update todos",
      description: "Write the session's todo list. Send the WHOLE list every time: it replaces what is there, and the user sees it as a checklist.",
      parameters: Type.Object({ todos: Type.Array(todo, { description: "The complete list, in order." }) }),
      execute: async (_id, { todos }) => {
        const list = writeTodos(sql, todos);
        try { onWrite?.(list); } catch { /* a listener must not fail a tool call */ }
        return { content: [{ type: "text", text: todoSummary(list) }], todos: list };
      },
    },
    {
      name: "todoread",
      label: "Read todos",
      description: "Read the session's todo list.",
      parameters: Type.Object({}),
      execute: async () => {
        const list = readTodos(sql);
        return { content: [{ type: "text", text: todoSummary(list) }], todos: list };
      },
    },
  ];
}
