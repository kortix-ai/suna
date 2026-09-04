// A FAITHFUL STUB OF THE PLATINUM ROUTES THE AGENT USES.
//
// Not a convenience mock: it implements the contracts as apps/api/src/api/
// sandboxes.ts defines them, including the parts that are easy to get wrong and
// that a forgiving mock would hide —
//
//   • /exec takes `cmd` as a string OR argv, and the route wraps a string as
//     ['sh','-c',v] itself. It takes timeout_ms (100..300000), NOT seconds.
//   • /exec answers {result: {ok, stdout, stderr, exit_code, error}}, with the
//     command's own failure inside `result`, not as an HTTP error.
//   • /files rejects a path containing a NUL byte or a `..` segment, with 400.
//   • a sandbox-scoped key may act ONLY on its sandbox — anything else is 403,
//     which is what makes handing this credential to an agent safe.
//
// The last one is the point of the whole exercise, so it is enforced here rather
// than assumed: the stub refuses a request for a sandbox the key is not scoped
// to, exactly as sandboxScope.ts does.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 7098);
const KEY = process.env.SANDBOX_KEY ?? "pt_live_stubkey";
const SANDBOX = process.env.SANDBOX_ID ?? "sbx_workspace";
const ROOT = process.env.WORK_ROOT ?? "/tmp/platinum-stub-work";

const json = (res, code, body) => {
  const b = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(b);
};
const text = (res, code, body) => {
  res.writeHead(code, { "content-type": "text/plain" });
  res.end(body);
};

// sanitiseGuestPath's rules, kept because a stub that accepts `..` would let a
// tool bug through that the real route stops.
function guestPath(p, fallback = "/") {
  const raw = p ?? fallback;
  if (raw.includes("\0")) throw new Error("path contains NUL byte");
  if (String(raw).split("/").includes("..")) throw new Error("path contains .. segment");
  // A path already under ROOT is a real host path — the case the ExecutionEnv
  // produces, because its exec-based ops (mkdir, mv, rm) run on the host in
  // this stub and must land where the file routes land. In the real sandbox
  // both are inside the VM and this branch never fires.
  const s = String(raw);
  const full = s.startsWith(ROOT + "/") || s === ROOT ? resolve(s) : resolve(ROOT, s.replace(/^\/+/, ""));
  if (full !== ROOT && !full.startsWith(ROOT + "/")) throw new Error("path escapes the sandbox");
  return full;
}

// PUT /files takes the request body as the file, byte for byte, as Platinum does.
const rawBody = (req) => new Promise((done) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => done(Buffer.concat(parts))); });
const body = (req) => new Promise((done, fail) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { try { done(raw ? JSON.parse(raw) : {}); } catch (e) { fail(e); } });
});

function run(cmd, timeoutMs) {
  const argv = Array.isArray(cmd) ? cmd : ["sh", "-c", cmd];
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(t);
      done({ ok: !killed && code === 0, stdout: out, stderr: err, exit_code: killed ? 124 : (code ?? -1), error: killed ? "timeout" : undefined });
    });
  });
}

createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url, "http://s");
    const m = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "no such route", code: "not_found" });
    const [, id, rest = ""] = m;

    // THE CONFINEMENT. A `sandbox:<id>` key reaches its own sandbox and nothing
    // else in the org — the property that makes this credential handable to an
    // agent at all.
    if (id !== SANDBOX) {
      return json(res, 403, { error: "forbidden: this API key is scoped to another sandbox", code: "sandbox_scope" });
    }

    await mkdir(ROOT, { recursive: true });

    if (rest === "/exec" && req.method === "POST") {
      const b = await body(req);
      if (!b.cmd) return json(res, 400, { error: "cmd required" });
      const ms = Math.min(Math.max(Number(b.timeout_ms ?? 30000), 100), 300000);
      const result = await run(b.cmd, ms);
      return json(res, 200, { result, error: result.ok ? undefined : result.error });
    }

    if (rest === "/files" && req.method === "GET") {
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      let full;
      try { full = guestPath(p); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const rawBytes = await readFile(full);
        if (!url.searchParams.has("offset") && !url.searchParams.has("limit")) {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(rawBytes.length) }); return res.end(rawBytes);
        }
        let content = rawBytes.toString("utf8");
        const offset = url.searchParams.get("offset");
        const limit = url.searchParams.get("limit");
        if (offset || limit) {
          const lines = content.split("\n");
          const o = Number(offset ?? 0);
          content = lines.slice(o, o + Number(limit ?? lines.length)).join("\n");
        }
        return text(res, 200, content);
      } catch { return json(res, 404, { error: "not found" }); }
    }

    if (rest === "/files" && req.method === "PUT") {
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      let full;
      try { full = guestPath(p); } catch (e) { return json(res, 400, { error: e.message }); }
      const raw = await rawBody(req);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, raw);
      return json(res, 200, { ok: true, path: p });
    }

    if (rest === "/files/stat" && req.method === "GET") {
      // {ok, size, mode, is_dir, mtime} from invmAgent.statFile; 404 when missing.
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      let full;
      try { full = guestPath(p); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const st = await stat(full);
        return json(res, 200, { ok: true, size: st.size, mode: st.mode, is_dir: st.isDirectory(), mtime: Math.floor(st.mtimeMs / 1000) });
      } catch { return json(res, 404, { error: "not found" }); }
    }

    if (rest === "/files/list" && req.method === "GET") {
      let full;
      try { full = guestPath(url.searchParams.get("path"), "/"); } catch (e) { return json(res, 400, { error: e.message }); }
      const items = await readdir(full, { withFileTypes: true });
      return json(res, 200, { ok: true, entries: items.map((d) => ({ name: d.name, size: 0, mode: 0, is_dir: d.isDirectory() })) });
    }

    if (rest === "/files/grep" && req.method === "GET") {
      const pattern = url.searchParams.get("pattern");
      if (!pattern) return json(res, 400, { error: "pattern required" });
      let full;
      try { full = guestPath(url.searchParams.get("path"), "/"); } catch (e) { return json(res, 400, { error: e.message }); }
      const max = Math.max(1, Math.min(Number(url.searchParams.get("max") ?? 500), 5000));
      const r = await run(["grep", "-rn", "--", pattern, full], 10000);
      const matches = (r.stdout || "").split("\n").filter(Boolean).slice(0, max).map((line) => {
        const mm = /^([^:]+):(\d+):(.*)$/.exec(line);
        return mm ? { path: mm[1].replace(ROOT, "") || "/", line: Number(mm[2]), text: mm[3] } : { path: "", line: 0, text: line };
      });
      return json(res, 200, { ok: true, matches });
    }

    return json(res, 404, { error: "no such route", code: "not_found" });
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[platinum-stub] :${PORT} sandbox=${SANDBOX}`));
