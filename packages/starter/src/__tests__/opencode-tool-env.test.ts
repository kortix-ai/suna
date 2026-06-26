import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const helperPath = join(
  import.meta.dir,
  "..",
  "..",
  "templates",
  "marketplace",
  "runtime",
  "tools",
  "lib",
  "get-env.ts",
);

let tempDir: string | null = null;

afterEach(() => {
  delete process.env.KORTIX_AGENT_ENV_FILE;
  delete process.env.KORTIX_API_URL;
  delete process.env.KORTIX_TOKEN;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function importFreshHelper() {
  return import(`${pathToFileURL(helperPath).href}?t=${Date.now()}`);
}

describe("opencode tool env helper", () => {
  test("reads Kortix router env from the live agent env file", async () => {
    tempDir = join(tmpdir(), `kortix-tool-env-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const envFile = join(tempDir, "agent-env.sh");
    writeFileSync(
      envFile,
      [
        "# generated shell env",
        "export KORTIX_API_URL='https://staging-api.kortix.com/v1'",
        "export KORTIX_TOKEN='kortix_sb_test'",
        "",
      ].join("\n"),
    );
    delete process.env.KORTIX_API_URL;
    delete process.env.KORTIX_TOKEN;
    process.env.KORTIX_AGENT_ENV_FILE = envFile;

    const { getEnv, getKortixRouterBase } = await importFreshHelper();

    expect(getEnv("KORTIX_API_URL")).toBe("https://staging-api.kortix.com/v1");
    expect(getEnv("KORTIX_TOKEN")).toBe("kortix_sb_test");
    expect(getKortixRouterBase("tavily")).toBe(
      "https://staging-api.kortix.com/v1/router/tavily",
    );
  });
});
