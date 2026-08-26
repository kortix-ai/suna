import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(DEMO_DIR, "fixture");
const DEFAULT_CACHE_DIR = join(DEMO_DIR, ".demo-cache");

const elapsed = (startedAt) =>
  Math.round((performance.now() - startedAt) * 100) / 100;

const parsePositiveInteger = (value, name) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export function parseOptions(argv) {
  const options = {
    cacheDir: DEFAULT_CACHE_DIR,
    files: 1000,
    fileKb: 16,
    json: false,
    rebuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--rebuild") {
      options.rebuild = true;
    } else if (argument === "--cache") {
      options.cacheDir = argv[++index];
    } else if (argument === "--files") {
      options.files = parsePositiveInteger(argv[++index], "--files");
    } else if (argument === "--file-kb") {
      options.fileKb = parsePositiveInteger(argv[++index], "--file-kb");
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.cacheDir) throw new Error("--cache requires a path");
  return options;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const errorOutput = Buffer.concat(stderr).toString("utf8");
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${exitCode}): ${errorOutput || output}`,
    );
  }
  return output.trim();
}

function createPayload(seed, size) {
  const buffer = Buffer.allocUnsafe(size);
  let state = (seed + 1) * 2654435761;
  for (let offset = 0; offset < size; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer.writeUInt32LE(state >>> 0, offset);
  }
  return buffer;
}

export async function ensureDemoSource(options) {
  const startedAt = performance.now();
  const [serverSource, configSource] = await Promise.all([
    readFile(join(FIXTURE_DIR, "server.ts")),
    readFile(join(FIXTURE_DIR, "kortix.config.ts")),
  ]);
  const identity = createHash("sha256")
    .update(`v1:${options.files}:${options.fileKb}:`)
    .update(serverSource)
    .update(configSource)
    .digest("hex")
    .slice(0, 12);
  const sourceDir = join(options.cacheDir, `source-${identity}`);
  const bareRepo = join(options.cacheDir, `source-${identity}.git`);

  try {
    const [sourceMarker, bareMarker] = await Promise.all([
      readFile(join(sourceDir, ".demo-ready"), "utf8"),
      stat(join(bareRepo, "HEAD")),
    ]);
    if (sourceMarker.trim() === identity && bareMarker.isFile()) {
      return {
        sourceDir,
        repoUrl: pathToFileURL(bareRepo).href,
        setupMs: elapsed(startedAt),
        cacheHit: true,
      };
    }
  } catch {}

  await mkdir(options.cacheDir, { recursive: true });
  await rm(sourceDir, { recursive: true, force: true });
  await rm(bareRepo, { recursive: true, force: true });
  await mkdir(join(sourceDir, "src"), { recursive: true });
  await mkdir(join(sourceDir, "workspace-data"), { recursive: true });
  await Promise.all([
    copyFile(join(FIXTURE_DIR, "server.ts"), join(sourceDir, "src/server.ts")),
    copyFile(
      join(FIXTURE_DIR, "kortix.config.ts"),
      join(sourceDir, "src/kortix.config.ts"),
    ),
    writeFile(
      join(sourceDir, "package.json"),
      `${JSON.stringify({ name: "compiled-boot-source", private: true, type: "module" }, null, 2)}\n`,
    ),
  ]);

  const bytesPerFile = options.fileKb * 1024;
  for (let index = 0; index < options.files; index += 1) {
    await writeFile(
      join(
        sourceDir,
        "workspace-data",
        `${String(index).padStart(5, "0")}.bin`,
      ),
      createPayload(index, bytesPerFile),
    );
  }

  await run("git", ["init", "--quiet"], { cwd: sourceDir });
  await run("git", ["config", "user.name", "Compiled Boot Demo"], {
    cwd: sourceDir,
  });
  await run("git", ["config", "user.email", "demo@localhost"], {
    cwd: sourceDir,
  });
  await run("git", ["add", "."], { cwd: sourceDir });
  await run("git", ["commit", "--quiet", "-m", "demo source"], {
    cwd: sourceDir,
  });
  await run("git", ["clone", "--quiet", "--bare", sourceDir, bareRepo]);
  await writeFile(join(sourceDir, ".demo-ready"), `${identity}\n`);

  return {
    sourceDir,
    repoUrl: pathToFileURL(bareRepo).href,
    setupMs: elapsed(startedAt),
    cacheHit: false,
  };
}

export async function compileBundle(entrypoint, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: dirname(outputPath),
    naming: basename(outputPath),
    format: "esm",
    target: "node",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  return stat(outputPath);
}

async function waitForReady(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`server did not become ready in ${timeoutMs} ms: ${stderr}`),
      );
    }, timeoutMs);

    const finish = (value, error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.event === "ready" && Number.isInteger(message.port)) {
            finish(message);
            return;
          }
        } catch {}
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error) => finish(undefined, error);
    const onClose = (code) =>
      finish(
        undefined,
        new Error(`server exited before ready (${code}): ${stderr}`),
      );

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export async function startAndVerify(bundlePath) {
  const startedAt = performance.now();
  const child = spawn(process.env.DEMO_NODE_BINARY ?? "node", [bundlePath], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const ready = await waitForReady(child);
    const response = await fetch(`http://127.0.0.1:${ready.port}/health`);
    const health = await response.json();
    if (
      !response.ok ||
      health.status !== "ok" ||
      health.agent !== "compiled-boot-demo"
    ) {
      throw new Error(
        `health verification failed: ${response.status} ${JSON.stringify(health)}`,
      );
    }
    return { startMs: elapsed(startedAt), health };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function runCloneAndCompile(options) {
  const source = await ensureDemoSource(options);
  const runtimeDir = await mkdtemp(join(tmpdir(), "clone-compile-"));
  const checkoutDir = join(runtimeDir, "checkout");
  const bootStartedAt = performance.now();

  try {
    const cloneStartedAt = performance.now();
    await run("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--no-tags",
      source.repoUrl,
      checkoutDir,
    ]);
    const cloneMs = elapsed(cloneStartedAt);

    const compileStartedAt = performance.now();
    const bundlePath = join(checkoutDir, "dist/server.mjs");
    const bundle = await compileBundle(
      join(checkoutDir, "src/server.ts"),
      bundlePath,
    );
    const compileMs = elapsed(compileStartedAt);
    const started = await startAndVerify(bundlePath);

    return {
      path: "clone-compile-start",
      setupExcludedMs: source.setupMs,
      setupCacheHit: source.cacheHit,
      cloneMs,
      compileMs,
      startMs: started.startMs,
      bootMs: elapsed(bootStartedAt),
      bundleBytes: bundle.size,
      sourceBytes: options.files * options.fileKb * 1024,
      health: started.health,
    };
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

export async function runPrecompiled(options) {
  const source = await ensureDemoSource(options);
  const commit = await run("git", ["rev-parse", "HEAD"], {
    cwd: source.sourceDir,
  });
  const artifactPath = join(
    options.cacheDir,
    "artifacts",
    commit,
    "server.mjs",
  );
  const precompileStartedAt = performance.now();
  let artifactCacheHit = false;

  if (!options.rebuild) {
    try {
      artifactCacheHit = (await stat(artifactPath)).isFile();
    } catch {}
  }
  if (!artifactCacheHit) {
    await rm(artifactPath, { force: true });
    await compileBundle(join(source.sourceDir, "src/server.ts"), artifactPath);
  }
  const precompileMs = elapsed(precompileStartedAt);
  const artifact = await stat(artifactPath);
  const runtimeDir = await mkdtemp(join(tmpdir(), "precompiled-"));
  const runtimeBundle = join(runtimeDir, "server.mjs");
  const bootStartedAt = performance.now();

  try {
    const deliveryStartedAt = performance.now();
    await cp(artifactPath, runtimeBundle);
    const deliveryMs = elapsed(deliveryStartedAt);
    let sourcePresentAtBoot = true;
    try {
      await stat(join(runtimeDir, "src"));
    } catch {
      sourcePresentAtBoot = false;
    }
    const started = await startAndVerify(runtimeBundle);

    return {
      path: "precompiled-mjs-start",
      setupExcludedMs: source.setupMs,
      setupCacheHit: source.cacheHit,
      precompileExcludedMs: precompileMs,
      artifactCacheHit,
      deliveryMs,
      startMs: started.startMs,
      bootMs: elapsed(bootStartedAt),
      artifactBytes: artifact.size,
      sourcePresentAtBoot,
      artifactPath,
      health: started.health,
    };
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

export function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.path === "clone-compile-start") {
    process.stdout.write(
      [
        "OLD PATH: clone -> compile -> start",
        `  fixture setup (excluded): ${result.setupExcludedMs} ms${result.setupCacheHit ? " (cached)" : ""}`,
        `  git clone:                ${result.cloneMs} ms`,
        `  compile server.mjs:       ${result.compileMs} ms`,
        `  start + health:           ${result.startMs} ms`,
        `  BOOT TOTAL:               ${result.bootMs} ms`,
        `  source payload:           ${result.sourceBytes} bytes`,
        `  output bundle:            ${result.bundleBytes} bytes`,
      ].join("\n") + "\n",
    );
    return;
  }

  process.stdout.write(
    [
      "NEW PATH: precompiled server.mjs -> start",
      `  fixture setup (excluded):  ${result.setupExcludedMs} ms${result.setupCacheHit ? " (cached)" : ""}`,
      `  precompile (excluded):      ${result.precompileExcludedMs} ms${result.artifactCacheHit ? " (cached)" : ""}`,
      `  deliver server.mjs:        ${result.deliveryMs} ms`,
      `  start + health:            ${result.startMs} ms`,
      `  BOOT TOTAL:                ${result.bootMs} ms`,
      `  artifact:                  ${result.artifactBytes} bytes`,
      `  source present at boot:    ${result.sourcePresentAtBoot}`,
      `  saved artifact:            ${result.artifactPath}`,
    ].join("\n") + "\n",
  );
}
