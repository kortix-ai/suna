import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LocalGitRepository {
  repoUrl: string;
  root: string;
  dispose(): Promise<void>;
}

export async function createLocalGitRepository(name: string): Promise<LocalGitRepository> {
  const root = await mkdtemp(join(tmpdir(), "ke2e-git-"));
  const repoUrl = join(root, "remote.git");
  const work = join(root, "work");
  try {
    await git(["init", "--bare", "--initial-branch=main", repoUrl]);
    await git(["init", "--initial-branch=main", work]);
    await git(["-C", work, "config", "user.name", "Kortix Local E2E"]);
    await git(["-C", work, "config", "user.email", "local-e2e@kortix.test"]);
    await writeFile(join(work, "README.md"), `# ${name}\n`);
    await writeFile(
      join(work, "kortix.yaml"),
      `kortix_version: 2\nproject:\n  name: ${name}\ndefault_agent: kortix\nagents:\n  kortix: {}\n`,
    );
    await git(["-C", work, "add", "README.md", "kortix.yaml"]);
    await git(["-C", work, "commit", "-m", "seed local e2e repository"]);
    await git(["-C", work, "remote", "add", "origin", repoUrl]);
    await git(["-C", work, "push", "-u", "origin", "main"]);
    return {
      repoUrl,
      root,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function git(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const processResult = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    processResult.stdout.setEncoding("utf8");
    processResult.stderr.setEncoding("utf8");
    processResult.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    processResult.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    processResult.once("error", reject);
    processResult.once("exit", (exitCode) => {
      if (exitCode === 0) resolve();
      else {
        reject(new Error(`git ${args.join(" ")} failed (${exitCode}): ${(stderr || stdout).trim()}`));
      }
    });
  });
}

/**
 * Commit one file onto `main` of a local bare repository through a throwaway
 * clone — the flow-side way to put a `kortix-<slug>.yaml` (or any file) in a
 * project when no API route writes it.
 */
export async function commitFileToLocalRepository(
  repoUrl: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "ke2e-git-commit-"));
  try {
    await git(["clone", "--quiet", repoUrl, work]);
    await git(["-C", work, "config", "user.name", "Kortix Local E2E"]);
    await git(["-C", work, "config", "user.email", "local-e2e@kortix.test"]);
    await writeFile(join(work, filePath), content);
    await git(["-C", work, "add", filePath]);
    await git(["-C", work, "commit", "--quiet", "-m", message]);
    await git(["-C", work, "push", "--quiet", "origin", "main"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
