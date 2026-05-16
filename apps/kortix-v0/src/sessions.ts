import { randomUUID } from "node:crypto";
import { getProject } from "./db";
import { getConfig } from "./env";
import { createRemoteSessionBranch, diffStat } from "./git";
import { insertProposal, insertSession, updateSession, getSession } from "./db";
import { createDaytonaSession } from "./providers/daytona";
import type { Proposal, SessionRun } from "./types";

export interface CreateSessionInput {
  prompt?: string;
  agentName?: string;
  baseRef?: string;
  provider?: "daytona";
  detached?: boolean;
}

function sessionId(): string {
  return `ses_${randomUUID().replace(/-/g, "")}`;
}

function branchForSession(id: string): string {
  return `kortix/session/${id}`;
}

function isLocalRepoUrl(repoUrl: string): boolean {
  return repoUrl.startsWith("/") || repoUrl.startsWith("./") || repoUrl.startsWith("../") || repoUrl.startsWith("file:");
}

export async function createSessionRun(projectId: string, input: CreateSessionInput = {}): Promise<SessionRun> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const id = sessionId();
  const baseRef = input.baseRef || project.defaultBranch;
  const branchName = branchForSession(id);
  const agentName = input.agentName?.trim() || "default";
  const sandboxProvider = input.provider || "daytona";
  let session = insertSession({
    id,
    projectId: project.id,
    branchName,
    baseRef,
    sandboxProvider,
    agentName,
    status: "branching",
  });

  if (sandboxProvider === "daytona" && isLocalRepoUrl(project.repoUrl)) {
    return updateSession(session.id, {
      status: "failed",
      error: "This project uses a local Git path. Daytona sandboxes can only clone repos reachable from inside the sandbox. Push this repo to a reachable Git remote or back it with a managed Git service endpoint.",
    });
  }

  if (input.detached) {
    void provisionSession(id, input.prompt);
    return session;
  }

  return provisionSession(id, input.prompt);
}

async function provisionSession(sessionIdValue: string, prompt?: string): Promise<SessionRun> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);
  const project = getProject(session.projectId);
  if (!project) throw new Error(`Project not found: ${session.projectId}`);

  try {
    updateSession(session.id, { status: "branching", error: null });
    const branchReady = createRemoteSessionBranch(project, session.branchName, session.baseRef);
    updateSession(session.id, { status: "provisioning", error: null });

    const [provisioned] = await Promise.all([
      createDaytonaSession({
        project,
        branchName: session.branchName,
        baseRef: session.baseRef,
        sessionId: session.id,
        agentName: session.agentName,
        prompt,
      }),
      branchReady,
    ]);

    return updateSession(session.id, {
      sandboxId: provisioned.sandboxId,
      sandboxUrl: provisioned.sandboxUrl,
      opencodeSessionId: provisioned.opencodeSessionId,
      status: "running",
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return updateSession(session.id, { status: "failed", error: message });
  }
}

function openCodeUrl(sandboxUrl: string, path: string): string {
  const base = new URL(sandboxUrl);
  const next = new URL(path, base.origin);
  const token = base.searchParams.get("DAYTONA_SANDBOX_AUTH_KEY");
  if (token) next.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", token);
  return next.toString();
}

function simplifyMessage(message: any): Record<string, unknown> {
  const info = message?.info || message || {};
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return {
    id: info.id || message?.id || null,
    role: info.role || message?.role || null,
    agent: info.agent || message?.agent || null,
    providerID: info.providerID || info.model?.providerID || null,
    modelID: info.modelID || info.model?.modelID || null,
    error: info.error?.data?.message || info.error?.message || null,
    completed: Boolean(info.time?.completed),
    createdAt: info.time?.created || null,
    updatedAt: info.time?.updated || info.time?.completed || null,
    text: parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n"),
  };
}

function parseModel(model: string | null): { providerID: string; modelID: string } | null {
  if (!model?.trim() || !model.includes("/")) return null;
  const [providerID, ...modelParts] = model.trim().split("/");
  return { providerID, modelID: modelParts.join("/") };
}

function openCodeAgentPayload(agentName?: string | null): Record<string, string> {
  const agent = agentName?.trim();
  return agent && agent !== "default" ? { agent } : {};
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { "X-Daytona-Skip-Preview-Warning": "true" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${text || response.statusText}`.trim());
  }
  return response.json();
}

async function postJson(url: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Daytona-Skip-Preview-Warning": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${text || response.statusText}`.trim());
  }
  const text = await response.text();
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, text };
  }
}

export async function sendSessionPrompt(sessionIdValue: string, prompt: string, agentName?: string): Promise<Record<string, unknown>> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);
  if (!prompt?.trim()) throw new Error("Prompt is required");
  if (!session.sandboxUrl || !session.opencodeSessionId) {
    throw new Error("OpenCode session is not attached yet.");
  }

  const model = parseModel(getConfig().openCodeModel);
  const agentPayload = openCodeAgentPayload(agentName || session.agentName);
  await postJson(
    openCodeUrl(session.sandboxUrl, `/session/${encodeURIComponent(session.opencodeSessionId)}/prompt_async?directory=%2Fworkspace`),
    {
      ...agentPayload,
      parts: [{ type: "text", text: prompt.trim() }],
      ...(model ? { model } : {}),
    },
  );

  return getSessionLive(session.id);
}

export async function abortSessionPrompt(sessionIdValue: string): Promise<Record<string, unknown>> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);
  if (!session.sandboxUrl || !session.opencodeSessionId) {
    throw new Error("OpenCode session is not attached yet.");
  }

  await postJson(
    openCodeUrl(session.sandboxUrl, `/session/${encodeURIComponent(session.opencodeSessionId)}/abort?directory=%2Fworkspace`),
    {},
  );

  return getSessionLive(session.id);
}

export async function getSessionLive(sessionIdValue: string): Promise<Record<string, unknown>> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);

  const changes = await getSessionChanges(session.id).catch((err) => ({
    text: "",
    error: err instanceof Error ? err.message : String(err),
  }));

  if (!session.sandboxUrl || !session.opencodeSessionId) {
    return {
      session,
      changes,
      live: {
        reachable: false,
        error: session.error || "OpenCode session is not attached yet.",
        opencodeSession: null,
        messages: [],
      },
    };
  }

  try {
    const [opencodeSession, messages] = await Promise.all([
      fetchJson(openCodeUrl(session.sandboxUrl, `/session/${encodeURIComponent(session.opencodeSessionId)}?directory=%2Fworkspace`)),
      fetchJson(openCodeUrl(session.sandboxUrl, `/session/${encodeURIComponent(session.opencodeSessionId)}/message?directory=%2Fworkspace`)),
    ]);
    return {
      session,
      changes,
      live: {
        reachable: true,
        error: null,
        opencodeSession,
        messages: Array.isArray(messages) ? messages.slice(-30).map(simplifyMessage) : [],
      },
    };
  } catch (err) {
    return {
      session,
      changes,
      live: {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
        opencodeSession: null,
        messages: [],
      },
    };
  }
}

export async function getSessionChanges(sessionIdValue: string): Promise<Record<string, unknown>> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);
  const project = getProject(session.projectId);
  if (!project) throw new Error(`Project not found: ${session.projectId}`);
  return diffStat(project, session.branchName, session.baseRef);
}

export async function createProposalForSession(sessionIdValue: string): Promise<Proposal> {
  const session = getSession(sessionIdValue);
  if (!session) throw new Error(`Session not found: ${sessionIdValue}`);
  const stat = await getSessionChanges(session.id);
  return insertProposal({
    id: randomUUID(),
    projectId: session.projectId,
    sessionId: session.id,
    branchName: session.branchName,
    diffStatJson: JSON.stringify(stat),
  });
}
