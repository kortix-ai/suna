import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { getConfig, publicConfig } from "./env";
import { allProjects, createProject, getProjectDetail, getProjectOrThrow, inspectRepo, loadProjectConfig, readRepoUrlFile } from "./projects";
import { listRepoFiles, readRepoFile } from "./git";
import { abortSessionPrompt, createProposalForSession, createSessionRun, getSessionChanges, getSessionLive, sendSessionPrompt } from "./sessions";
import { getSession, listSessions } from "./db";
import { listSecrets, projectSecretStatus, removeSecret, saveSecret } from "./secrets";
import { renderUi } from "./ui";

const app = new Hono();

async function jsonBody(c: any): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

app.onError((err, c) => {
  return c.json({ error: err.message || String(err) }, 500);
});

app.get("/", (c) => c.html(renderUi()));

app.get("/api/config", (c) => c.json(publicConfig()));

app.get("/schemas/project/v0", (c) => {
  const schema = readFileSync(new URL("../schemas/project-v0.schema.json", import.meta.url), "utf8");
  return c.json(JSON.parse(schema));
});

app.get("/api/projects", (c) => c.json(allProjects()));

app.post("/api/repos/inspect", async (c) => {
  const body = await jsonBody(c);
  return c.json(await inspectRepo(body.repoUrl, body.ref));
});

app.post("/api/repos/file", async (c) => {
  const body = await jsonBody(c);
  return c.json(await readRepoUrlFile(body.repoUrl, body.path, body.ref));
});

app.post("/api/projects", async (c) => {
  const body = await jsonBody(c);
  const project = await createProject({
    name: body.name,
    repoUrl: body.repoUrl,
    initialize: body.initialize,
    managed: body.managed,
  });
  return c.json(project, 201);
});

app.get("/api/projects/:id", async (c) => {
  const detail = await getProjectDetail(c.req.param("id"));
  return c.json(detail);
});

app.get("/api/projects/:id/files", async (c) => {
  const project = await getProjectOrThrow(c.req.param("id"));
  const files = await listRepoFiles(
    project,
    c.req.query("ref") || project.defaultBranch,
    c.req.query("path") || undefined,
  );
  return c.json(files);
});

app.get("/api/projects/:id/files/content", async (c) => {
  const project = await getProjectOrThrow(c.req.param("id"));
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query param is required" }, 400);
  const ref = c.req.query("ref") || project.defaultBranch;
  const content = await readRepoFile(project, ref, path);
  return c.json({ path, ref, content });
});

app.get("/api/projects/:id/sessions", (c) => {
  return c.json(listSessions(c.req.param("id")));
});

app.get("/api/projects/:id/secrets", (c) => {
  return c.json(listSecrets(c.req.param("id")));
});

app.get("/api/projects/:id/secrets/status", async (c) => {
  const project = await getProjectOrThrow(c.req.param("id"));
  const config = await loadProjectConfig(project);
  return c.json(projectSecretStatus(project.id, config.env));
});

app.put("/api/projects/:id/secrets", async (c) => {
  const body = await jsonBody(c);
  return c.json(saveSecret({
    projectId: c.req.param("id"),
    key: String(body.key || ""),
    value: String(body.value || ""),
  }));
});

app.delete("/api/projects/:id/secrets/:key", (c) => {
  return c.json({ deleted: removeSecret(c.req.param("id"), c.req.param("key")) });
});

app.post("/api/projects/:id/sessions", async (c) => {
  const body = await jsonBody(c);
  const session = await createSessionRun(c.req.param("id"), {
    prompt: body.prompt,
    agentName: body.agentName,
    baseRef: body.baseRef,
    provider: body.provider || "daytona",
    detached: true,
  });
  return c.json(session, 201);
});

app.get("/api/sessions/:id", (c) => {
  const session = getSession(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

app.get("/api/sessions/:id/changes", async (c) => {
  return c.json(await getSessionChanges(c.req.param("id")));
});

app.get("/api/sessions/:id/live", async (c) => {
  return c.json(await getSessionLive(c.req.param("id")));
});

app.post("/api/sessions/:id/messages", async (c) => {
  const body = await jsonBody(c);
  return c.json(await sendSessionPrompt(c.req.param("id"), String(body.prompt || ""), body.agentName));
});

app.post("/api/sessions/:id/abort", async (c) => {
  return c.json(await abortSessionPrompt(c.req.param("id")));
});

app.post("/api/sessions/:id/proposals", async (c) => {
  return c.json(await createProposalForSession(c.req.param("id")), 201);
});

export function startServer() {
  const cfg = getConfig();
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: cfg.idleTimeout,
    fetch: app.fetch,
  });
  console.log(`Kortix V0 listening on http://${cfg.host}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
