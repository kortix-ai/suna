import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "./env";
import { starterFiles } from "./starter";
import type { FileEntry, Project } from "./types";

export interface GitResult {
  stdout: string;
  stderr: string;
}

function authHeaderArgs(): string[] {
  const token = getConfig().githubToken;
  if (!token) return [];
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`];
}

export async function runGit(args: string[], cwd?: string, auth = true): Promise<GitResult> {
  const fullArgs = auth ? [...authHeaderArgs(), ...args] : args;
  const proc = Bun.spawn(["git", ...fullArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `git ${args[0]} failed`).trim());
  }
  return { stdout, stderr: stderr.trim() };
}

function repoCachePath(projectId: string): string {
  return join(getConfig().dataDir, "cache", "repos", `${projectId}.git`);
}

export function repoInspectId(repoUrl: string): string {
  return `inspect-${createHash("sha256").update(repoUrl).digest("hex").slice(0, 20)}`;
}

async function githubApi(path: string, init: RequestInit = {}): Promise<any> {
  const token = getConfig().githubToken;
  if (!token) {
    throw new Error("GitHub token is required to create managed Git projects for now.");
  }
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.message || text || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return body;
}

function slugifyRepoName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    || "project";
}

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

async function createGitHubBranch(project: Project, branchName: string, baseRef: string): Promise<boolean> {
  if (!getConfig().githubToken) return false;
  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) return false;

  const owner = encodeURIComponent(parsed.owner);
  const repo = encodeURIComponent(parsed.repo);
  const base = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseRef)}`);
  const sha = base?.object?.sha;
  if (!sha) throw new Error(`GitHub did not return a SHA for ${baseRef}`);

  await githubApi(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha,
    }),
  });
  return true;
}

export async function detectDefaultBranch(repoUrl: string): Promise<string> {
  const head = await runGit(["ls-remote", "--symref", repoUrl, "HEAD"]);
  const symref = head.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ref: refs/heads/") && line.endsWith("\tHEAD"));
  if (symref) {
    return symref.replace(/^ref: refs\/heads\//, "").replace(/\tHEAD$/, "");
  }

  const heads = await runGit(["ls-remote", "--heads", repoUrl]);
  const branches = heads.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/\trefs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => Boolean(branch));
  return branches.includes("main")
    ? "main"
    : branches.includes("master")
      ? "master"
      : branches[0] || "main";
}

const refreshLocks = new Map<string, Promise<string>>();
const lastRefreshAt = new Map<string, number>();

function gitRefreshIntervalMs(): number {
  const value = Number(process.env.KORTIX_V0_GIT_REFRESH_INTERVAL_MS || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

async function doRefreshMirror(project: Project, force = false): Promise<string> {
  const repoPath = repoCachePath(project.id);
  mkdirSync(dirname(repoPath), { recursive: true });
  const refspec = `+refs/heads/${project.defaultBranch}:refs/heads/${project.defaultBranch}`;
  if (existsSync(join(repoPath, "shallow"))) {
    rmSync(repoPath, { recursive: true, force: true });
  }
  if (!existsSync(repoPath)) {
    await runGit([
      "clone",
      "--bare",
      "--single-branch",
      "--branch",
      project.defaultBranch,
      project.repoUrl,
      repoPath,
    ]);
    lastRefreshAt.set(project.id, Date.now());
  } else {
    const lastRefresh = lastRefreshAt.get(project.id) || 0;
    if (!force && !lastRefresh) {
      lastRefreshAt.set(project.id, Date.now());
      return repoPath;
    }
    if (!force && Date.now() - lastRefresh < gitRefreshIntervalMs()) return repoPath;
    await runGit(["remote", "set-url", "origin", project.repoUrl], repoPath);
    await runGit(["fetch", "--prune", "origin", refspec], repoPath);
    lastRefreshAt.set(project.id, Date.now());
  }
  return repoPath;
}

export async function refreshMirror(project: Project, force = false): Promise<string> {
  const current = refreshLocks.get(project.id);
  if (current) return current;
  const next = doRefreshMirror(project, force).finally(() => refreshLocks.delete(project.id));
  refreshLocks.set(project.id, next);
  return next;
}

function normalizeTreePath(input?: string | null): string | null {
  if (!input || input === "." || input === "/") return null;
  if (input.startsWith("/") || input.includes("..")) {
    throw new Error("Invalid path");
  }
  return input.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function listRepoFiles(project: Project, ref?: string, path?: string | null): Promise<FileEntry[]> {
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const treePath = normalizeTreePath(path);
  const args = ["ls-tree", "-r", treeRef, "--"];
  if (treePath) args.push(treePath);
  const result = await runGit(args, repoPath, false);
  if (!result.stdout) return [];
  return result.stdout.split("\n").map<FileEntry | null>((line) => {
    const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\t(.+)$/);
    if (!match) return null;
    if (match[1] !== "blob") return null;
    return {
      path: match[2] || "",
      type: "file" as const,
      size: null,
    };
  }).filter((entry): entry is FileEntry => Boolean(entry));
}

export async function readRepoFile(project: Project, ref: string | undefined, filePath: string): Promise<string> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error("File path is required");
  const repoPath = await refreshMirror(project);
  const result = await runGit(["show", `${ref || project.defaultBranch}:${normalized}`], repoPath, false);
  return result.stdout;
}

export async function createRemoteSessionBranch(project: Project, branchName: string, baseRef?: string): Promise<void> {
  const base = baseRef || project.defaultBranch;
  if (await createGitHubBranch(project, branchName, base)) return;

  const repoPath = await refreshMirror(project, true);
  await runGit(["fetch", "origin", `+refs/heads/${base}:refs/heads/${base}`], repoPath);
  await runGit(["update-ref", `refs/heads/${branchName}`, `refs/heads/${base}`], repoPath, false);
  await runGit(["push", "origin", `refs/heads/${branchName}:refs/heads/${branchName}`], repoPath);
}

export async function diffStat(project: Project, branchName: string, baseRef?: string): Promise<Record<string, unknown>> {
  const repoPath = await refreshMirror(project);
  const base = baseRef || project.defaultBranch;
  const result = await runGit(["diff", "--stat", `refs/heads/${base}...refs/heads/${branchName}`], repoPath, false).catch(() => ({ stdout: "", stderr: "" }));
  return { text: result.stdout };
}

export function githubCloneCommand(repoUrl: string, branchName: string, baseRef: string): string {
  const script = [
    "set -euo pipefail",
    "git_auth=()",
    'if [ -n "${KORTIX_GITHUB_TOKEN:-}" ]; then',
    '  auth_header=$(printf "x-access-token:%s" "$KORTIX_GITHUB_TOKEN" | base64 | tr -d "\\n")',
    '  git_auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}")',
    "fi",
    "mkdir -p /workspace",
    "rm -rf /workspace/.kortix",
    `git "\${git_auth[@]}" clone --branch ${shellQuote(baseRef)} --single-branch ${shellQuote(repoUrl)} /workspace/.kortix`,
    "cd /workspace/.kortix",
    `git "\${git_auth[@]}" fetch origin ${shellQuote(baseRef)}`,
    `git reset --hard ${shellQuote(`origin/${baseRef}`)}`,
    `git "\${git_auth[@]}" fetch origin ${shellQuote(`${branchName}:refs/remotes/origin/${branchName}`)}`,
    `git checkout -B ${shellQuote(branchName)} ${shellQuote(`refs/remotes/origin/${branchName}`)}`,
  ].join("\n");
  return `bash -lc ${shellQuote(script)}`;
}

export async function initializeStarterRepo(repoUrl: string, projectName: string, branch = "main"): Promise<void> {
  const tmpRoot = join(getConfig().dataDir, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = join(tmpRoot, `init-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    await runGit(["init"], dir, false);
    await runGit(["checkout", "-b", branch], dir, false);
    await runGit(["config", "user.email", "bot@kortix.local"], dir, false);
    await runGit(["config", "user.name", "Kortix V0"], dir, false);
    for (const file of starterFiles(projectName)) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    await runGit(["add", "."], dir, false);
    await runGit(["commit", "-m", "Initialize Kortix project"], dir, false);
    await runGit(["remote", "add", "origin", repoUrl], dir, false);
    await runGit(["push", "-u", "origin", branch], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function createManagedStarterRepo(projectId: string, projectName: string, branch = "main"): Promise<{ repoUrl: string; defaultBranch: string }> {
  const shortId = projectId.replace(/-/g, "").slice(0, 8);
  const repoName = `kortix-${slugifyRepoName(projectName)}-${shortId}`;
  const created = await githubApi("/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false,
      description: `Managed Kortix project for ${projectName}`,
    }),
  });
  const repoUrl = String(created.clone_url || "");
  const fullName = String(created.full_name || "");
  if (!repoUrl || !fullName) {
    throw new Error("GitHub did not return a clone URL for the managed project.");
  }

  try {
    await initializeStarterRepo(repoUrl, projectName, branch);
    return { repoUrl, defaultBranch: branch };
  } catch (err) {
    await githubApi(`/repos/${fullName}`, { method: "DELETE" }).catch(() => null);
    throw err;
  }
}
