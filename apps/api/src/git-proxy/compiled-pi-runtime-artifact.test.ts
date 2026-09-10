import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitBackedProject } from "../projects/git/types";
import { __resetPiWorkerBundleForTests } from "./pi-worker-bundle";
import { compilePiRuntime } from "./compiled-pi-runtime";

let storedArtifact: {
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
  content: Buffer;
} | null = null;

mock.module("./pi-runtime-store", () => ({
  readStoredPiRuntimeArtifact: async () => storedArtifact,
  putStoredPiRuntimeArtifact: async () => undefined,
}));

const {
  __clearCompiledPiRuntimeBuildsForTests,
  buildCompiledPiRuntimeArtifact,
} = await import("./compiled-pi-runtime-artifact");

const roots: string[] = [];
const originalCacheRoot = process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;
const originalBundlePath = process.env.KORTIX_PI_WORKER_BUNDLE_PATH;

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Kortix Test",
      GIT_AUTHOR_EMAIL: "test@kortix.local",
      GIT_COMMITTER_NAME: "Kortix Test",
      GIT_COMMITTER_EMAIL: "test@kortix.local",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return stdout.trim();
}

async function makeProject(input: {
  manifest: string;
  agentFiles?: Record<string, string>;
}): Promise<{ project: GitBackedProject; sha: string }> {
  const root = mkdtempSync(join(tmpdir(), "kortix-pi-runtime-source-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  await git(["init", "-b", "main"], source);
  writeFileSync(join(source, "kortix.yaml"), input.manifest);
  for (const [path, content] of Object.entries(input.agentFiles ?? {})) {
    const absolute = join(source, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  await git(["add", "-A"], source);
  await git(["commit", "-m", "runtime source"], source);
  return {
    project: {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${source}`,
      defaultBranch: "main",
      manifestPath: "kortix.yaml",
      gitAuthToken: "test-token",
    },
    sha: await git(["rev-parse", "HEAD"], source),
  };
}

beforeEach(() => {
  storedArtifact = null;
  __clearCompiledPiRuntimeBuildsForTests();
  __resetPiWorkerBundleForTests();
  const bundleRoot = mkdtempSync(join(tmpdir(), "kortix-pi-runtime-bundle-"));
  const cacheRoot = mkdtempSync(join(tmpdir(), "kortix-pi-runtime-cache-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "kortix-pi-runtime-mirrors-"));
  roots.push(bundleRoot, cacheRoot, mirrorRoot);
  const bundlePath = join(bundleRoot, "worker.mjs");
  writeFileSync(bundlePath, 'console.log("kortix-worker starting:test");\n');
  process.env.KORTIX_PI_WORKER_BUNDLE_PATH = bundlePath;
  process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cacheRoot;
  process.env.KORTIX_GIT_CACHE_DIR = mirrorRoot;
});

afterEach(() => {
  __clearCompiledPiRuntimeBuildsForTests();
  __resetPiWorkerBundleForTests();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  if (originalCacheRoot === undefined)
    delete process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
  else process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = originalCacheRoot;
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
  if (originalBundlePath === undefined)
    delete process.env.KORTIX_PI_WORKER_BUNDLE_PATH;
  else process.env.KORTIX_PI_WORKER_BUNDLE_PATH = originalBundlePath;
});

describe("buildCompiledPiRuntimeArtifact selected-agent config", () => {
  test('bakes the selected gateway model limits into the immutable artifact', async () => {
    const { project, sha } = await makeProject({
      manifest: 'kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n',
      agentFiles: { '.kortix/pi/agents/build.md': '---\nmodel: kortix/gpt-5.6-luna\n---\nBuild safely.\n' },
    });
    const artifact = await buildCompiledPiRuntimeArtifact(project, 'main', sha, 'build');
    expect(artifact.manifest.model_limits).toMatchObject({ model: 'gpt-5.6-luna', context: 1050000 });
  });

  test("rejects malformed selected-agent frontmatter instead of baking a null config", async () => {
    const { project, sha } = await makeProject({
      manifest:
        "kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md":
          "---\nmode: invalid\n---\nBuild safely.\n",
      },
    });

    await expect(
      buildCompiledPiRuntimeArtifact(project, "main", sha, "build"),
    ).rejects.toThrow(/mode/);
  });

  test("rejects an undeclared selected agent instead of baking another agent config", async () => {
    const { project, sha } = await makeProject({
      manifest:
        "kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md": "Build safely.\n",
      },
    });

    await expect(
      buildCompiledPiRuntimeArtifact(project, "main", sha, "missing"),
    ).rejects.toThrow('Agent "missing" is not declared.');
  });

  test("rejects a Pi artifact with no selected or default agent", async () => {
    const { project, sha } = await makeProject({
      manifest: "kortix_version: 3\nagents:\n  build: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md": "Build safely.\n",
      },
    });

    await expect(
      buildCompiledPiRuntimeArtifact(project, "main", sha),
    ).rejects.toThrow("Pi runtime artifact requires a selected agent.");
  });

  test("compiles only the selected agent when another agent is malformed", async () => {
    const { project, sha } = await makeProject({
      manifest:
        "kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n  broken: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md": "Build safely.\n",
        ".kortix/pi/agents/broken.md": "---\nmode: invalid\n---\nBroken.\n",
      },
    });

    const artifact = await buildCompiledPiRuntimeArtifact(
      project,
      "main",
      sha,
      "build",
    );
    const compiled = JSON.parse(artifact.manifest.agent_config ?? "null") as {
      agent: Record<string, { prompt?: string }>;
    };

    expect(Object.keys(compiled.agent)).toEqual(["build"]);
    expect(compiled.agent.build?.prompt).toBe("Build safely.\n");
  });

  test("rejects a stored artifact whose selected-agent config is null", async () => {
    const { project, sha } = await makeProject({
      manifest:
        "kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md": "Build safely.\n",
      },
    });
    const invalid = compilePiRuntime({
      projectId: project.projectId,
      ref: "main",
      sourceSha: sha,
      agentConfig: null,
      defaultAgent: "build",
      workerBundle: 'console.log("kortix-worker starting:test");\n',
    });
    storedArtifact = {
      sha256: invalid.sha256,
      size: invalid.size,
      manifest: invalid.manifest as unknown as Record<string, unknown>,
      content: Buffer.from(invalid.source),
    };

    const artifact = await buildCompiledPiRuntimeArtifact(
      project,
      "main",
      sha,
      "build",
    );

    expect(artifact.cacheHit).toBe(false);
    expect(artifact.manifest.agent_config).not.toBeNull();
  });

  test("rejects a stored artifact whose selected-agent config has an invalid shape", async () => {
    const { project, sha } = await makeProject({
      manifest:
        "kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n",
      agentFiles: {
        ".kortix/pi/agents/build.md": "Build safely.\n",
      },
    });
    const invalid = compilePiRuntime({
      projectId: project.projectId,
      ref: "main",
      sourceSha: sha,
      agentConfig: JSON.stringify({ agent: { build: { prompt: 42 } } }),
      defaultAgent: "build",
      workerBundle: 'console.log("kortix-worker starting:test");\n',
    });
    storedArtifact = {
      sha256: invalid.sha256,
      size: invalid.size,
      manifest: invalid.manifest as unknown as Record<string, unknown>,
      content: Buffer.from(invalid.source),
    };

    const artifact = await buildCompiledPiRuntimeArtifact(
      project,
      "main",
      sha,
      "build",
    );

    expect(artifact.cacheHit).toBe(false);
    expect(
      JSON.parse(artifact.manifest.agent_config ?? "null").agent.build.prompt,
    ).toBe("Build safely.\n");
  });
});

test('project source and relative imports are pinned into the selected artifact', async () => {
  const {project, sha} = await makeProject({
    manifest: 'kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n',
    agentFiles: {
      '.kortix/pi/agents/build.md': 'Build safely.\n',
      '.kortix/pi/agents/build.ts': "import {definePiAgent} from '@kortix/sdk/pi';import {level} from '../helper';export default definePiAgent(()=>({thinkingLevel:level}));",
      '.kortix/pi/helper.ts': "export const level='low';",
    },
  });
  const artifact = await buildCompiledPiRuntimeArtifact(project, 'main', sha, 'build');
  expect(artifact.manifest.source_sha).toBe(sha);
  expect(artifact.manifest.agent_module?.entry).toBe('.kortix/pi/agents/build.ts');
  expect(artifact.manifest.agent_module?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await Bun.file(artifact.path).text()).toContain('__KORTIX_PI_AGENT__');
  const cached = await buildCompiledPiRuntimeArtifact(project, 'main', sha, 'build');
  expect(cached.sha256).toBe(artifact.sha256);
});

test('actual Git compilation rejects ignored behavior, ambiguous source, and incomplete dependency locks', async () => {
  for (const files of [
    { '.kortix/pi/agents/build.md': '---\nplugins: []\n---\nBuild.' },
    { '.kortix/pi/agents/build.ts': 'export default ()=>({});', '.kortix/pi/agents/build.js': 'export default ()=>({});' },
    { '.kortix/pi/agents/build.ts': 'export default ()=>({});', '.kortix/pi/package.json': '{}' },
  ] as Record<string, string>[]) {
    const {project,sha}=await makeProject({manifest:'kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n',agentFiles:{'.kortix/pi/agents/build.md':'Build safely.\n',...files}});
    await expect(buildCompiledPiRuntimeArtifact(project,'main',sha,'build')).rejects.toThrow(/not supported|multiple source|both package/);
  }
});
