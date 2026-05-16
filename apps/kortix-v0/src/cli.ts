import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startServer } from "./server";
import { createProject, allProjects, getProjectOrThrow, inspectRepo, loadProjectConfig } from "./projects";
import { createSessionRun } from "./sessions";
import { projectSecretStatus, removeSecret, saveSecret } from "./secrets";
import { starterFiles } from "./starter";
import { runGit } from "./git";

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

async function initLocalProject(name: string, target?: string): Promise<void> {
  const dir = resolve(target || name);
  if (existsSync(dir)) {
    throw new Error(`Target already exists: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const file of starterFiles(name)) {
    const path = resolve(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, "utf8");
  }
  await runGit(["init"], dir, false);
  await runGit(["checkout", "-b", "main"], dir, false);
  await runGit(["config", "user.email", "bot@kortix.local"], dir, false);
  await runGit(["config", "user.name", "Kortix V0"], dir, false);
  await runGit(["add", "."], dir, false);
  await runGit(["commit", "-m", "Initialize Kortix project"], dir, false);
  console.log(`Initialized ${dir}`);
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === "start") {
    startServer();
    return;
  }

  if (command === "init") {
    const name = positional[0] || str(flags, "name");
    if (!name) throw new Error("Usage: kortix-v0 init <name> [--dir path]");
    await initLocalProject(name, str(flags, "dir"));
    return;
  }

  if (command === "projects:list") {
    console.table(allProjects().map((p) => ({ id: p.id, name: p.name, repo: p.repoUrl, branch: p.defaultBranch })));
    return;
  }

  if (command === "project:create") {
    const repoUrl = str(flags, "repo-url") || positional[0];
    if (!repoUrl && !flags.managed) throw new Error("Usage: kortix-v0 project:create --repo-url url [--name name] [--initialize] or project:create --managed --name name");
    const project = await createProject({
      name: str(flags, "name"),
      repoUrl,
      initialize: Boolean(flags.initialize),
      managed: Boolean(flags.managed),
    });
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  if (command === "project:inspect") {
    const repoUrl = str(flags, "repo-url") || positional[0];
    if (!repoUrl) throw new Error("Usage: kortix-v0 project:inspect --repo-url url");
    const detail = await inspectRepo(repoUrl);
    console.log(JSON.stringify({
      repoUrl: detail.repoUrl,
      defaultBranch: detail.defaultBranch,
      isKortixRepo: detail.isKortixRepo,
      fileCount: detail.fileCount,
      env: detail.config.env,
      agents: detail.config.agents.map((agent) => agent.name),
      skills: detail.config.skills.map((skill) => skill.name),
    }, null, 2));
    return;
  }

  if (command === "session:create") {
    const projectId = str(flags, "project");
    if (!projectId) throw new Error("Usage: kortix-v0 session:create --project project-id [--agent name] [--prompt text]");
    const session = await createSessionRun(projectId, { agentName: str(flags, "agent"), prompt: str(flags, "prompt") });
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  if (command === "secrets:list") {
    const projectId = str(flags, "project");
    if (!projectId) throw new Error("Usage: kortix-v0 secrets:list --project project-id");
    const project = await getProjectOrThrow(projectId);
    const config = await loadProjectConfig(project);
    console.log(JSON.stringify(projectSecretStatus(project.id, config.env), null, 2));
    return;
  }

  if (command === "secrets:set") {
    const projectId = str(flags, "project");
    const key = str(flags, "key") || positional[0];
    const value = str(flags, "value") || positional[1];
    if (!projectId || !key || !value) throw new Error("Usage: kortix-v0 secrets:set --project project-id --key NAME --value VALUE");
    console.log(JSON.stringify(saveSecret({ projectId, key, value }), null, 2));
    return;
  }

  if (command === "secrets:delete") {
    const projectId = str(flags, "project");
    const key = str(flags, "key") || positional[0];
    if (!projectId || !key) throw new Error("Usage: kortix-v0 secrets:delete --project project-id --key NAME");
    console.log(JSON.stringify({ deleted: removeSecret(projectId, key) }, null, 2));
    return;
  }

  console.log(`kortix-v0 commands:
  start
  init <name> [--dir path]
  project:create --repo-url url [--name name] [--initialize]
  project:create --managed --name name
  project:inspect --repo-url url
  projects:list
  session:create --project project-id [--agent name] [--prompt text]
  secrets:list --project project-id
  secrets:set --project project-id --key NAME --value VALUE
  secrets:delete --project project-id --key NAME`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
