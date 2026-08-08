#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  console.log(`[package-quality] ${command.join(" ")}`);
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`${command.join(" ")} exited with code ${code}`);
}

async function rejectFocusedTests(): Promise<void> {
  const child = Bun.spawn(
    [
      "rg",
      "-n",
      String.raw`\b(describe|test|it)\.only\(`,
      "apps",
      "packages",
      "-g",
      "*.test.ts",
      "-g",
      "*.test.tsx",
      "-g",
      "*.test.mts",
    ],
    { cwd: root, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code === 1) return;
  if (code !== 0) throw new Error(`focused-test scan exited with code ${code}`);
  process.stderr.write(output);
  throw new Error("focused test (.only) committed");
}

async function verifyPublishablePackage(directory: string): Promise<void> {
  const packageDirectory = resolve(root, "packages", directory);
  const packagePath = resolve(packageDirectory, "package.json");
  const original = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(original) as {
    name: string;
    scripts?: Record<string, string>;
  };
  const build = parsed.scripts?.["build:bundles"] ? "build:bundles" : "build";

  await run(["pnpm", "--filter", parsed.name, "run", build]);
  try {
    await run(["node", "../../scripts/stage-npm-publish.mjs"], {
      cwd: packageDirectory,
      env: { ...process.env, VERSION: "0.0.0-local-test" },
    });
    await run(["npm", "pack", "--dry-run"], { cwd: packageDirectory });
  } finally {
    await writeFile(packagePath, original);
  }
}

await run(["node", "scripts/stage-npm-publish.test.mjs"]);
await rejectFocusedTests();
for (const directory of ["llm-catalog", "sdk", "executor-sdk"]) {
  await verifyPublishablePackage(directory);
}
await run(["pnpm", "--filter", "@kortix/sdk", "run", "smoke:install"]);
await run(
  [
    "pnpm",
    "--filter",
    "./packages/**",
    "--filter",
    "./apps/**",
    "--if-present",
    "test",
  ],
  { env: { ...process.env, KORTIX_TEST_TIMEOUT_MS: "15000" } },
);
