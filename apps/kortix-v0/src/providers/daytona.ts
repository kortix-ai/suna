import { Daytona } from "@daytonaio/sdk";
import { getConfig } from "../env";
import { githubCloneCommand } from "../git";
import { sandboxEnvForProject } from "../secrets";
import type { Project } from "../types";

export interface DaytonaSessionResult {
  sandboxId: string;
  sandboxUrl: string | null;
  opencodeSessionId: string | null;
}

interface PreviewAccess {
  url: string;
  accessUrl: string;
  token?: string;
}

function requireDaytonaConfig() {
  const cfg = getConfig();
  if (!cfg.daytonaApiKey) throw new Error("Missing DAYTONA_API_KEY");
  if (!cfg.daytonaSnapshot) throw new Error("Missing DAYTONA_SNAPSHOT");
  return cfg;
}

function daytonaClient(): Daytona {
  const cfg = requireDaytonaConfig();
  return new Daytona({
    apiKey: cfg.daytonaApiKey!,
    apiUrl: cfg.daytonaApiUrl || undefined,
    target: cfg.daytonaTarget || undefined,
  });
}

function daemonEntrypoint(): string[] {
  const command = [
    "set -eu",
    "if [ \"${KORTIX_FAST_OPENCODE:-1}\" = \"1\" ]; then",
    "WORKSPACE=\"${KORTIX_WORKSPACE:-/workspace}\"",
    "TARGET=\"${KORTIX_PROJECT_TARGET:-${WORKSPACE}/.kortix}\"",
    "REPO_URL=\"${KORTIX_BOOTSTRAP_REPO_URL:-${KORTIX_REPO_URL:-}}\"",
    "BASE_REF=\"${KORTIX_BASE_REF:-${KORTIX_DEFAULT_BRANCH:-main}}\"",
    "BRANCH_NAME=\"${KORTIX_BRANCH_NAME:-}\"",
    "SERVICE_PORT=\"${KORTIX_SERVICE_PORT:-4096}\"",
    "git_with_auth() {",
    "  if [ -n \"${KORTIX_GITHUB_TOKEN:-}\" ]; then",
    "    auth_header=$(printf 'x-access-token:%s' \"$KORTIX_GITHUB_TOKEN\" | base64 | tr -d '\\n')",
    "    git -c \"http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}\" \"$@\"",
    "  else",
    "    git \"$@\"",
    "  fi",
    "}",
    "if [ \"${KORTIX_PROJECT_AUTO_CLONE:-0}\" = \"1\" ] || [ \"${KORTIX_PROJECT_AUTO_CLONE:-false}\" = \"true\" ]; then",
    "  if [ -z \"$REPO_URL\" ]; then echo '[kortix-daemon:fast] KORTIX_REPO_URL is unset' >&2; exit 1; fi",
    "  mkdir -p \"$(dirname \"$TARGET\")\"",
    "  if [ -d \"$TARGET/.git\" ]; then",
    "    git_with_auth -C \"$TARGET\" remote set-url origin \"$REPO_URL\"",
    "    git_with_auth -C \"$TARGET\" fetch --prune origin \"+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}\"",
    "  else",
    "    rm -rf \"$TARGET\"",
    "    git_with_auth clone --no-tags --single-branch --branch \"$BASE_REF\" \"$REPO_URL\" \"$TARGET\"",
    "  fi",
    "  git_with_auth -C \"$TARGET\" reset --hard \"origin/${BASE_REF}\"",
    "  if [ -n \"$BRANCH_NAME\" ]; then",
    "    attempt=1",
    "    max_attempts=\"${KORTIX_BRANCH_FETCH_ATTEMPTS:-60}\"",
    "    while [ \"$attempt\" -le \"$max_attempts\" ]; do",
    "      if git_with_auth -C \"$TARGET\" fetch origin \"+refs/heads/${BRANCH_NAME}:refs/remotes/origin/${BRANCH_NAME}\" >/tmp/kortix-branch-fetch.log 2>&1; then",
    "        git_with_auth -C \"$TARGET\" checkout -B \"$BRANCH_NAME\" \"refs/remotes/origin/${BRANCH_NAME}\"",
    "        break",
    "      fi",
    "      sleep \"${KORTIX_BRANCH_FETCH_DELAY:-0.25}\"",
    "      attempt=$((attempt + 1))",
    "    done",
    "    if [ \"$attempt\" -gt \"$max_attempts\" ]; then cat /tmp/kortix-branch-fetch.log >&2 2>/dev/null || true; exit 1; fi",
    "  fi",
    "fi",
    "export HOME=\"$WORKSPACE\"",
    "export KORTIX_WORKSPACE=\"$WORKSPACE\"",
    "export KORTIX_PROJECT_ROOT=\"$TARGET\"",
    "export KORTIX_DEFAULT_OPENCODE_CONFIG_DIR=\"${KORTIX_DEFAULT_OPENCODE_CONFIG_DIR:-}\"",
    "if [ -f \"$TARGET/.opencode/opencode.jsonc\" ]; then export OPENCODE_CONFIG_DIR=\"$TARGET/.opencode\"; elif [ -n \"$KORTIX_DEFAULT_OPENCODE_CONFIG_DIR\" ]; then export OPENCODE_CONFIG_DIR=\"$KORTIX_DEFAULT_OPENCODE_CONFIG_DIR\"; else unset OPENCODE_CONFIG_DIR; fi",
    "export OPENCODE_FILE_ROOT=\"${OPENCODE_FILE_ROOT:-/}\"",
    "unset PORT APP_PORT",
    "cd \"$WORKSPACE\"",
    "if command -v kortix-daemon >/dev/null 2>&1; then exec kortix-daemon start; fi",
    "if [ -x /usr/local/bin/opencode-kortix ]; then exec /usr/local/bin/opencode-kortix serve --port \"$SERVICE_PORT\" --hostname 0.0.0.0; fi",
    "if command -v opencode-kortix >/dev/null 2>&1; then exec opencode-kortix serve --port \"$SERVICE_PORT\" --hostname 0.0.0.0; fi",
    "if command -v opencode >/dev/null 2>&1; then exec opencode serve --port \"$SERVICE_PORT\" --hostname 0.0.0.0; fi",
    "echo '[kortix-daemon:fast] opencode binary missing' >&2",
    "sleep 3600",
    "fi",
    "if command -v kortix-daemon >/dev/null 2>&1; then exec kortix-daemon entrypoint; fi",
    "mkdir -p /workspace /tmp",
    "echo '[kortix-daemon:fallback] waiting for /workspace/.kortix repo'",
    "while [ ! -d /workspace/.kortix/.git ]; do sleep 0.1; done",
    "cd /workspace",
    "export KORTIX_PROJECT_ROOT=/workspace/.kortix",
    "export OPENCODE_CONFIG_DIR=/workspace/.kortix/.opencode",
    "echo '[kortix-daemon:fallback] starting opencode on :4096'",
    "if command -v opencode-kortix >/dev/null 2>&1; then exec opencode-kortix serve --port 4096; fi",
    "if command -v opencode >/dev/null 2>&1; then exec opencode serve --port 4096; fi",
    "echo '[kortix-daemon:fallback] opencode binary missing'",
    "sleep 3600",
  ].join("\n");
  return ["/bin/sh", "-lc", command];
}

const SNAPSHOT_READY_TTL_MS = 5 * 60_000;
const snapshotReadyUntil = new Map<string, number>();
const snapshotReadyPromises = new Map<string, Promise<void>>();

async function ensureSnapshot(daytona: Daytona, snapshot: string): Promise<void> {
  const cfg = getConfig();
  let existing: any = null;
  try {
    existing = await daytona.snapshot.get(snapshot);
  } catch {
    existing = null;
  }

  if (existing) {
    const state = String((existing as any).state || "").toLowerCase();
    if (state === "active" || state === "ready") return;
    if (state.includes("error") || state.includes("fail")) {
      await daytona.snapshot.delete(existing);
    } else {
      await waitForSnapshotActive(daytona, snapshot);
      return;
    }
  }

  // Missing or failed snapshots are expected for fresh commits. Build from the matching image tag.
  console.log(`Creating Daytona snapshot ${snapshot} from ${cfg.daytonaImage}`);
  try {
    await daytona.snapshot.create(
      {
        name: snapshot,
        image: cfg.daytonaImage,
        entrypoint: daemonEntrypoint(),
      },
      {
        timeout: 900,
        onLogs: (chunk) => {
          if (chunk.trim()) console.log(`[daytona snapshot] ${chunk.trim()}`);
        },
      },
    );
    await waitForSnapshotActive(daytona, snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cfg.daytonaImage === "kortix/computer:dev-latest" || !message.includes("manifest unknown")) {
      throw err;
    }
    console.log(`Retrying Daytona snapshot ${snapshot} from kortix/computer:dev-latest`);
    await daytona.snapshot.create(
      {
        name: snapshot,
        image: "kortix/computer:dev-latest",
        entrypoint: daemonEntrypoint(),
      },
      {
        timeout: 900,
        onLogs: (chunk) => {
          if (chunk.trim()) console.log(`[daytona snapshot] ${chunk.trim()}`);
        },
      },
    );
    await waitForSnapshotActive(daytona, snapshot);
  }
}

async function ensureSnapshotCached(daytona: Daytona, snapshot: string): Promise<void> {
  const readyUntil = snapshotReadyUntil.get(snapshot) || 0;
  if (readyUntil > Date.now()) return;

  const pending = snapshotReadyPromises.get(snapshot);
  if (pending) return pending;

  const next = ensureSnapshot(daytona, snapshot)
    .then(() => {
      snapshotReadyUntil.set(snapshot, Date.now() + SNAPSHOT_READY_TTL_MS);
    })
    .finally(() => {
      snapshotReadyPromises.delete(snapshot);
    });
  snapshotReadyPromises.set(snapshot, next);
  return next;
}

export async function warmDaytonaRuntimeSnapshot(): Promise<string> {
  const cfg = requireDaytonaConfig();
  const snapshot = cfg.daytonaSnapshot!;
  await ensureSnapshotCached(daytonaClient(), snapshot);
  return snapshot;
}

async function waitForSnapshotActive(daytona: Daytona, snapshot: string, timeoutMs = 900_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const current: any = await daytona.snapshot.get(snapshot);
    lastState = String(current?.state || "unknown").toLowerCase();
    if (lastState === "active" || lastState === "ready") return;
    if (lastState.includes("error") || lastState.includes("fail")) {
      throw new Error(`Snapshot ${snapshot} failed: ${lastState}`);
    }
    await sleep(2000);
  }
  throw new Error(`Snapshot ${snapshot} did not become active in time. Last state: ${lastState}`);
}

async function exec(sandbox: any, command: string): Promise<string> {
  const result = await sandbox.process.executeCommand(command);
  const output = result?.result ?? result?.stdout ?? result?.output ?? "";
  const exitCode = result?.exitCode ?? result?.code ?? 0;
  if (exitCode && exitCode !== 0) {
    throw new Error(result?.error || result?.stderr || output || `Command failed with exit code ${exitCode}`);
  }
  return String(output || "");
}

function withPreviewAuth(url: string, token?: string): string {
  if (!token) return url;
  const next = new URL(url);
  next.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", token);
  return next.toString();
}

function previewRequestUrl(preview: PreviewAccess, path: string): string {
  const next = new URL(path, `${preview.url}/`);
  if (preview.token) next.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", preview.token);
  return next.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseModel(model: string | null): { providerID: string; modelID: string } | null {
  if (!model?.trim() || !model.includes("/")) return null;
  const [providerID, ...modelParts] = model.trim().split("/");
  return { providerID, modelID: modelParts.join("/") };
}

function inheritEnv(envVars: Record<string, string>): void {
  for (const key of [
    "KORTIX_TOKEN",
    "KORTIX_API_URL",
    "KORTIX_YOLO_API_KEY",
    "KORTIX_YOLO_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    const value = process.env[key];
    if (value) envVars[key] = value;
  }

}

async function getPreviewAccess(sandbox: any, port: number): Promise<PreviewAccess | null> {
  try {
    const link = await sandbox.getPreviewLink(port);
    const url = typeof link === "string" ? link : link?.url;
    const baseUrl = url ? String(url).replace(/\/$/, "") : null;
    if (!baseUrl) return null;
    const token = typeof link === "string" ? undefined : link?.token;
    return {
      url: baseUrl,
      accessUrl: withPreviewAuth(baseUrl, token),
      token,
    };
  } catch {
    return null;
  }
}

function openCodeAgentPayload(agentName: string): Record<string, string> {
  const agent = agentName.trim();
  return agent && agent !== "default" ? { agent } : {};
}

async function createOpenCodeSession(preview: PreviewAccess | null, agentName: string, prompt?: string): Promise<string | null> {
  if (!preview) return null;
  const model = parseModel(getConfig().openCodeModel);
  const headers = { "Content-Type": "application/json", "X-Daytona-Skip-Preview-Warning": "true" };
  const agentPayload = openCodeAgentPayload(agentName);
  try {
    let create: Response | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      create = await fetch(previewRequestUrl(preview, "/session?directory=%2Fworkspace"), {
        method: "POST",
        headers,
        body: JSON.stringify(agentPayload),
      }).catch(() => null);
      if (create?.ok) break;
      await sleep(250);
    }
    if (!create?.ok) return null;
    const created = await create.json();
    const sessionId = created?.id || created?.session?.id;
    if (sessionId && prompt?.trim()) {
      await fetch(previewRequestUrl(preview, `/session/${encodeURIComponent(sessionId)}/prompt_async?directory=%2Fworkspace`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...agentPayload,
          parts: [{ type: "text", text: prompt.trim() }],
          ...(model ? { model } : {}),
        }),
      }).catch(() => null);
    }
    return sessionId || null;
  } catch {
    return null;
  }
}

export async function createDaytonaSession(input: {
  project: Project;
  branchName: string;
  baseRef: string;
  sessionId: string;
  agentName: string;
  prompt?: string;
}): Promise<DaytonaSessionResult> {
  const cfg = requireDaytonaConfig();
  const snapshot = cfg.daytonaSnapshot!;
  const daytona = daytonaClient();
  await ensureSnapshotCached(daytona, snapshot);
  const envVars: Record<string, string> = {
    KORTIX_PROJECT_ID: input.project.id,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_BRANCH_NAME: input.branchName,
    KORTIX_REPO_URL: input.project.repoUrl,
    KORTIX_BOOTSTRAP_REPO_URL: input.project.repoUrl,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_DEFAULT_BRANCH: input.project.defaultBranch,
    KORTIX_PROJECT_TARGET: "/workspace/.kortix",
    KORTIX_PROJECT_AUTO_CLONE: "1",
    KORTIX_PERSISTENCE: "git-proposal",
    KORTIX_FAST_OPENCODE: process.env.KORTIX_FAST_OPENCODE || "1",
    KORTIX_SERVICE_PORT: "4096",
    KORTIX_BRANCH_FETCH_ATTEMPTS: process.env.KORTIX_BRANCH_FETCH_ATTEMPTS || "80",
    KORTIX_BRANCH_FETCH_DELAY: process.env.KORTIX_BRANCH_FETCH_DELAY || "0.25",
  };
  if (cfg.githubToken) envVars.KORTIX_GITHUB_TOKEN = cfg.githubToken;
  inheritEnv(envVars);
  Object.assign(envVars, sandboxEnvForProject(input.project.id));
  const sandbox = await daytona.create(
    {
      snapshot,
      envVars,
      autoStopInterval: 30,
      autoArchiveInterval: 120,
      public: false,
    },
    { timeout: 300 },
  );

  if (process.env.KORTIX_V0_POST_CREATE_CLONE === "1") {
    await exec(sandbox, githubCloneCommand(input.project.repoUrl, input.branchName, input.baseRef));
  }

  const preview = await getPreviewAccess(sandbox, 4096);
  const opencodeSessionId = await createOpenCodeSession(preview, input.agentName, input.prompt);

  return {
    sandboxId: sandbox.id,
    sandboxUrl: preview?.accessUrl || null,
    opencodeSessionId,
  };
}
