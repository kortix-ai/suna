// A STUB CONTROL PLANE, so deploy.sh can be run instead of merely read.
//
// deploy.sh is the bridge to production and had never been executed once. It
// cannot be: celld is on no deployed environment (the runtime was reverted off
// main), so there is nothing to point it at. That is a reason to stub the
// control plane, not a reason to ship an unrun script — a deploy path nobody has
// executed is a design document with a shebang.
//
// The endpoints match apps/api/src/api/*.ts as the routes define them, including
// the parts deploy.sh depends on and could get wrong:
//
//   POST /v1/templates/from-spec  requires name + base_image, returns {id}
//   POST /v1/sandboxes            takes templateId OR an inline `image` spec,
//                                 plus envVars; returns {id}
//   GET  /v1/sandboxes/:id        returns orgId and internalIp — deploy.sh reads
//                                 the ORG from here rather than trusting a
//                                 passed-in value, because the host decides the
//                                 storage prefix
//   POST /v1/sandboxes/:id/stop|start
//
// It also RECORDS every call, so the test can assert what deploy.sh actually
// sent — particularly that the cell is created with CELLD_VAR_* envVars and no
// AWS credentials.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 7095);
const TOKEN = process.env.PT_TOKEN ?? "cp-stub-token";
const LOG = process.env.CALL_LOG ?? "/tmp/cp-stub-calls.json";
const calls = [];

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://cp");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep the raw text */ }
    calls.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization ?? null });
    writeFileSync(LOG, JSON.stringify(calls, null, 2));

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });

    if (url.pathname === "/v1/templates/from-spec" && req.method === "POST") {
      // The route requires these; a stub that accepts anything would hide a
      // deploy.sh that sends a spec the real builder rejects.
      if (!body.name || !body.base_image) return json(res, 400, { error: "name and base_image are required" });
      return json(res, 201, { id: "tpl_stub_agentdaemon", state: "ready", name: body.name });
    }

    if (url.pathname === "/v1/sandboxes" && req.method === "POST") {
      const isCell = !!body.image;
      if (!body.templateId && !body.image) return json(res, 400, { error: "templateId or image is required" });
      return json(res, 201, {
        id: isCell ? "sbx_stub_cell" : "sbx_stub_workspace",
        orgId: "org_stub_tenant",
        state: "starting",
        runtime: isCell ? "cell" : "microvm",
      });
    }

    const m = /^\/v1\/sandboxes\/([^/]+)(\/(stop|start))?$/.exec(url.pathname);
    if (m) {
      const [, id, , action] = m;
      if (action) return json(res, 200, { id, state: action === "stop" ? "stopped" : "starting" });
      return json(res, 200, {
        id,
        orgId: "org_stub_tenant",
        internalIp: "10.42.7.7",
        state: "running",
        runtime: id.includes("cell") ? "cell" : "microvm",
      });
    }

    return json(res, 404, { error: "no such route", code: "not_found" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[cp-stub] :${PORT}`));
