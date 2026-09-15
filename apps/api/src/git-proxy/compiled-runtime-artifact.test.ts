import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBackedProject } from "../projects/git/types";
import {
  __clearCompiledRuntimeBuildsForTests,
  buildCompiledRuntimeArtifact,
} from "./compiled-runtime-artifact";
import { resetCompiledAgentBundleForTests } from "./compiled-agent-bundle";

const roots: string[] = [];
const originalCacheRoot = process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;
const originalBundlePath = process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;

beforeEach(() => {
  resetCompiledAgentBundleForTests();
  const bundleRoot = mkdtempSync(join(tmpdir(), "kortix-runtime-test-bundle-"));
  roots.push(bundleRoot);
  const bundlePath = join(bundleRoot, "server.mjs");
  writeFileSync(bundlePath, 'console.log("kortix-sandbox-agent-server starting:test");\n');
  process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = bundlePath;
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ivan Bagarić",
      GIT_AUTHOR_EMAIL: "ino.bagaric.1@gmail.com",
      GIT_COMMITTER_NAME: "Ivan Bagarić",
      GIT_COMMITTER_EMAIL: "ino.bagaric.1@gmail.com",
    },
    encoding: "utf8",
  }).trim();
}

function makeProject(): {
  project: GitBackedProject;
  sha: string;
  source: string;
} {
  const root = mkdtempSync(join(tmpdir(), "kortix-runtime-source-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(join(source, ".kortix", "opencode", "agents"), { recursive: true });
  git(["init", "-b", "main"], source);
  writeFileSync(
    join(source, "kortix.yaml"),
    "kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n",
  );
  writeFileSync(
    join(source, ".kortix", "opencode", "agents", "kortix.md"),
    "---\nmode: primary\n---\nAnswer from the compiled runtime.\n",
  );
  writeFileSync(
    join(source, ".kortix", "opencode", "opencode.jsonc"),
    '{"default_agent":"kortix"}\n',
  );
  git(["add", "-A"], source);
  git(["commit", "-m", "runtime source"], source);
  return {
    project: {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${source}`,
      defaultBranch: "main",
      manifestPath: "kortix.yaml",
      gitAuthToken: "test-token",
    },
    sha: git(["rev-parse", "HEAD"], source),
    source,
  };
}

afterEach(() => {
  __clearCompiledRuntimeBuildsForTests();
  resetCompiledAgentBundleForTests();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  if (originalCacheRoot === undefined)
    delete process.env.KORTIX_COMPILED_BOOT_CACHE_DIR;
  else process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = originalCacheRoot;
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
  if (originalBundlePath === undefined) delete process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH;
  else process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = originalBundlePath;
});

describe("buildCompiledRuntimeArtifact", () => {
  test("compiles exact Git state into an executable OpenCode server artifact", async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), "kortix-runtime-cache-"));
    const mirrors = mkdtempSync(join(tmpdir(), "kortix-runtime-mirrors-"));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const artifact = await buildCompiledRuntimeArtifact(project, "main", sha);
    const manifest = JSON.parse(
      execFileSync(process.execPath, [artifact.path, "--manifest"], {
        encoding: "utf8",
      }),
    );

    expect(artifact.cacheHit).toBe(false);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.size).toBeGreaterThan(0);
    expect(manifest).toEqual(artifact.manifest);
    expect(JSON.parse(manifest.agent_config)).toEqual({
      agent: {
        kortix: {
          mode: "primary",
          prompt: "Answer from the compiled runtime.\n",
        },
      },
    });
    expect(manifest.opencode_config_dir).toBe(".kortix/opencode");
    expect(manifest.opencode_config_archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.opencode_config_archive_bytes).toBeGreaterThan(0);
  });

  test('OpenCode compiles the same YAML behavior and shared configuration directory', async () => {
    const { project, source } = makeProject();
    mkdirSync(join(source, 'config/shared'), { recursive: true });
    mkdirSync(join(source, 'prompts'), { recursive: true });
    writeFileSync(join(source, 'config/shared/opencode.jsonc'), '{"default_agent":"kortix"}');
    writeFileSync(join(source, 'prompts/kortix.md'), 'Shared prompt.');
    writeFileSync(join(source, 'kortix.yaml'), 'kortix_version: 2\nconfig_dir: config/shared\ndefault_agent: kortix\nagents:\n  kortix:\n    config:\n      model: provider/model\n      prompt: {file: prompts/kortix.md}\n      pi: {source: agents/pi.ts}\n');
    git(['add', '-A'], source);
    git(['commit', '-m', 'shared YAML source'], source);
    const sha = git(['rev-parse', 'HEAD'], source);
    const artifact = await buildCompiledRuntimeArtifact(project, 'main', sha);
    expect(JSON.parse(artifact.manifest.agent_config!)).toEqual({ model: 'provider/model', agent: {kortix: {model: 'provider/model', prompt: 'Shared prompt.'}} });
    expect(artifact.manifest.opencode_config_dir).toBe('config/shared');
    expect(artifact.manifest.opencode_config_archive_bytes).toBeGreaterThan(0);
  });

  test('an OpenCode artifact refuses an unreadable explicit YAML prompt', async () => {
    const { project, source } = makeProject();
    writeFileSync(join(source, 'kortix.yaml'), 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    config:\n      prompt: {file: prompts/missing.md}\n');
    git(['add', '-A'], source);
    git(['commit', '-m', 'missing explicit prompt'], source);
    const sha = git(['rev-parse', 'HEAD'], source);
    await expect(buildCompiledRuntimeArtifact(project, 'main', sha)).rejects.toThrow('regular Git file');
  });

  test("reuses a verified content-addressed artifact", async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), "kortix-runtime-cache-"));
    const mirrors = mkdtempSync(join(tmpdir(), "kortix-runtime-mirrors-"));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const first = await buildCompiledRuntimeArtifact(project, "main", sha);
    const second = await buildCompiledRuntimeArtifact(project, "main", sha);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path, "utf8")).toBe(
      readFileSync(first.path, "utf8"),
    );
  });

  test("rebuilds a cache entry whose body has no embedded manifest", async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), "kortix-runtime-cache-"));
    const mirrors = mkdtempSync(join(tmpdir(), "kortix-runtime-mirrors-"));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const first = await buildCompiledRuntimeArtifact(project, "main", sha);
    const invalidSource = "#!/usr/bin/env node\nprocess.exit(0);\n";
    writeFileSync(first.path, invalidSource);
    const metadataPath = join(
      cache,
      readdirSync(cache).find((name) => name.endsWith(".runtime.json"))!,
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.sha256 = createHash("sha256").update(invalidSource).digest("hex");
    metadata.size = Buffer.byteLength(invalidSource);
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);

    const rebuilt = await buildCompiledRuntimeArtifact(project, "main", sha);
    const rebuiltSource = readFileSync(rebuilt.path, "utf8");

    expect(rebuilt.cacheHit).toBe(false);
    expect(rebuiltSource).toContain("// kortix-manifest-base64url:");
  });

  test("changes the artifact identity when the bundled daemon changes", async () => {
    const { project, sha } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), "kortix-runtime-cache-"));
    const mirrors = mkdtempSync(join(tmpdir(), "kortix-runtime-mirrors-"));
    const bundles = mkdtempSync(join(tmpdir(), "kortix-runtime-bundles-"));
    roots.push(cache, mirrors, bundles);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    const firstBundle = join(bundles, "first.mjs");
    const secondBundle = join(bundles, "second.mjs");
    writeFileSync(firstBundle, 'console.log("kortix-sandbox-agent-server starting:first");\n');
    writeFileSync(secondBundle, 'console.log("kortix-sandbox-agent-server starting:second");\n');

    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = firstBundle;
    const first = await buildCompiledRuntimeArtifact(project, "main", sha);
    resetCompiledAgentBundleForTests();
    process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH = secondBundle;
    const second = await buildCompiledRuntimeArtifact(project, "main", sha);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(second.path, "utf8")).toContain("starting:second");
  });

  test("rejects a named ref that moved from the expected commit", async () => {
    const { project } = makeProject();
    const cache = mkdtempSync(join(tmpdir(), "kortix-runtime-cache-"));
    const mirrors = mkdtempSync(join(tmpdir(), "kortix-runtime-mirrors-"));
    roots.push(cache, mirrors);
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;

    await expect(
      buildCompiledRuntimeArtifact(project, "main", "a".repeat(40)),
    ).rejects.toThrow(/source moved/);
  });
});

test('OpenCode bundles declared environment files at the pinned commit and validates cached resource metadata', async () => {
  const { project, source } = makeProject();
  const cache = mkdtempSync(join(tmpdir(), 'opencode-resources-cache-'));
  const mirrors = mkdtempSync(join(tmpdir(), 'opencode-resources-mirror-'));
  roots.push(cache, mirrors);
  process.env.KORTIX_COMPILED_BOOT_CACHE_DIR = cache;
  process.env.KORTIX_GIT_CACHE_DIR = mirrors;
  mkdirSync(join(source, 'assets'));
  writeFileSync(join(source, 'assets', 'seed.txt'), 'pinned seed');
  writeFileSync(join(source, 'assets', 'helper.py'), 'print(42)');
  writeFileSync(join(source, 'kortix.yaml'), JSON.stringify({
    kortix_version: 2, default_agent: 'kortix', agents: {
      kortix: { config: { prompt: 'Use the template.' }, resources: { environment: [
        { source: 'assets/seed.txt', target: '/workspace/seed.txt', mode: 'seed' },
        { source: 'assets/helper.py', target: '/opt/kortix/helpers/helper.py', mode: 'read_only' },
      ] } },
      other: { config: { prompt: 'Another agent.' }, resources: { environment: [
        { source: 'assets/helper.py', target: '/workspace/other.py', mode: 'seed' },
      ] } },
      disabled: { enabled: false, resources: { environment: [
        { source: 'missing', target: '/workspace/disabled', mode: 'seed' },
      ] } },
    },
  }));
  git(['add', '.'], source); git(['commit', '-m', 'Declare resource files'], source);
  const sha = git(['rev-parse', 'HEAD'], source);
  writeFileSync(join(source, 'assets', 'seed.txt'), 'new seed');
  git(['commit', '-am', 'Move default branch'], source);
  const first = await buildCompiledRuntimeArtifact(project, sha, sha);
  expect(Object.keys(first.environmentResources ?? {})).toEqual(['kortix', 'other']);
  expect(Buffer.from(first.environmentResources!.kortix[0].content, 'base64').toString()).toBe('pinned seed');
  expect(first.environmentResources!.other[0].target).toBe('/workspace/other.py');
  expect(first.manifest.agent_resources_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(first.path, 'utf8')).toContain('export const environmentResources = ');
  const printed = JSON.parse(execFileSync(process.execPath, [first.path, '--manifest'], { encoding: 'utf8' }));
  expect(printed.agent_resources_sha256).toBe(first.manifest.agent_resources_sha256);
  expect((await buildCompiledRuntimeArtifact(project, sha, sha)).cacheHit).toBe(true);
  const metadataPath = first.path.replace('.server.mjs', '.runtime.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  metadata.environmentResources.kortix[0].content = Buffer.from('tampered').toString('base64');
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const repaired = await buildCompiledRuntimeArtifact(project, sha, sha);
  expect(repaired.cacheHit).toBe(false);
  expect(repaired.environmentResources).toEqual(first.environmentResources);
});


test("the executable OpenCode artifact exposes its own verified resource map before loading the daemon", async () => {
  const { project, source } = makeProject();
  writeFileSync(join(source, "kortix.yaml"), "kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    resources:\n      environment:\n        - {source: seed.txt, target: /workspace/seed.txt, mode: seed}\n");
  writeFileSync(join(source, "seed.txt"), "compiled payload");
  git(["add", "-A"], source);
  git(["commit", "-m", "Executable resource bundle"], source);
  const sha = git(["rev-parse", "HEAD"], source);
  const artifact = await buildCompiledRuntimeArtifact(project, sha, sha);
  const configRoot = mkdtempSync(join(tmpdir(), "kortix-config-runtime-"));
  roots.push(configRoot);
  const result = execFileSync(process.execPath, ["-e", `await import(${JSON.stringify(artifact.path)}); console.log(JSON.stringify(globalThis[Symbol.for("kortix.compiled.environment-resources")]));`], {
    encoding: "utf8", env: { PATH: process.env.PATH, KORTIX_COMPILED_CONFIG_ROOT: configRoot },
  });
  const bundled = JSON.parse(result.trim().split("\n").at(-1)!);
  expect(bundled).toEqual({projectId: project.projectId, sourceSha: sha, agents: artifact.environmentResources});
  expect(Buffer.from(bundled.agents.kortix[0].content, "base64").toString()).toBe("compiled payload");
});

test("OpenCode rejects combined resource payloads above 8 MiB across agents", async () => {
  const { project, source } = makeProject();
  writeFileSync(join(source, "kortix.yaml"), "kortix_version: 2\ndefault_agent: first\nagents:\n  first:\n    resources:\n      environment:\n        - {source: payload, target: /workspace/a, mode: seed}\n  second:\n    resources:\n      environment:\n        - {source: payload, target: /workspace/b, mode: seed}\n");
  writeFileSync(join(source, "payload"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  git(["add", "-A"], source);
  git(["commit", "-m", "Oversized combined resources"], source);
  const sha = git(["rev-parse", "HEAD"], source);
  await expect(buildCompiledRuntimeArtifact(project, sha, sha)).rejects.toThrow("OpenCode runtime resources exceed 8 MiB");
}, 30_000);

test("OpenCode rejects missing declared environment files during compilation", async () => {
  const { project, source } = makeProject();
  writeFileSync(join(source, "kortix.yaml"), "kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    resources:\n      environment:\n        - {source: missing.txt, target: /workspace/template.txt, mode: seed}\n");
  git(["add", "-A"], source);
  git(["commit", "-m", "Missing environment resource"], source);
  const sha = git(["rev-parse", "HEAD"], source);
  await expect(buildCompiledRuntimeArtifact(project, sha, sha)).rejects.toThrow("must be an existing regular Git file");
});
