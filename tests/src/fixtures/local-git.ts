import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LocalGitRepository {
  repoUrl: string;
  root: string;
  dispose(): Promise<void>;
}

export async function createLocalGitRepository(name: string, opts?: { allowAllSecrets?: boolean }): Promise<LocalGitRepository> {
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
      `kortix_version: 2\nproject:\n  name: ${name}\ndefault_agent: kortix\nagents:\n  kortix:${opts?.allowAllSecrets ? '\n    secrets: all' : ' {}'}\n`,
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
 * Serve a local fixture project's bare repository over HTTP through Git's CGI
 * backend, and point the project at it. The API proxy speaks HTTP; a filesystem
 * `repo_url` is not an HTTP origin. Returns null on a deployed target, whose
 * managed repository is already an HTTP origin.
 */
export async function serveFixtureRepoLocally(
  ctx: { env: { target: string } },
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  projectId: string,
  label: string,
): Promise<import('node:http').Server | null> {
  if (ctx.env.target !== 'local') return null;
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { rows } = await db.query('SELECT repo_url FROM kortix.projects WHERE project_id = $1', [projectId]);
  const repo = rows[0].repo_url as string;
  const localGitServer = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const child = spawn('git', ['http-backend'], { env: { ...process.env,
      GIT_PROJECT_ROOT: repo, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: 'ke2e', REMOTE_ADDR: '127.0.0.1' } });
    const chunks: Buffer[] = [];
    req.pipe(child.stdin);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // git http-backend explains every refusal on STDERR. Discarding it is
    // why three CI failures of this flow (2026-09-21 run 35625012282,
    // 2026-09-22 run 35701044493, and one re-run in between) produced a
    // bare `400` and no cause: the proxy forwards the upstream status, so
    // the failing request reads as "the API returned 400" when the API is
    // only relaying what this server said. Keep it, and print it with the
    // request that earned it.
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', () => { res.writeHead(502); res.end(); });
    child.on('close', () => {
      const body = Buffer.concat(chunks);
      const split = body.indexOf('\r\n\r\n');
      if (split < 0) {
        console.error(`[${label}] http-backend produced no headers for ${req.method} ${req.url}${stderr ? ` — stderr: ${stderr.trim()}` : ''}`);
        res.writeHead(502);
        res.end();
        return;
      }
      for (const line of body.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon); const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
        else res.setHeader(name, value);
      }
      if (res.statusCode >= 400) {
        console.error(`[${label}] http-backend answered ${res.statusCode} for ${req.method} ${req.url}${stderr ? ` — stderr: ${stderr.trim()}` : ''}`);
      }
      res.end(body.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => localGitServer.listen(0, '127.0.0.1', resolve));
  const port = (localGitServer.address() as import('node:net').AddressInfo).port;
  await db.query('UPDATE kortix.projects SET repo_url = $1 WHERE project_id = $2',
    [`http://127.0.0.1:${port}`, projectId]);
  return localGitServer;
}
