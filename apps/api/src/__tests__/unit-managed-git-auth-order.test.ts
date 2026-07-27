import { describe, expect, test } from "bun:test";

describe("managed GitHub authentication order", () => {
  test("checks the managed PAT before minting a GitHub App token", async () => {
    const source = await Bun.file(
      new URL("../projects/lib/git.ts", import.meta.url),
    ).text();
    const start = source.indexOf("export async function resolveProjectGitAuth");
    const end = source.indexOf(
      "export async function withProjectGitAuth",
      start,
    );
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(resolver.indexOf("const pat = managedGithubToken()")).toBeLessThan(
      resolver.indexOf("createInstallationToken("),
    );
  });

  test('does not reuse managed Git credentials for marketplace reads', async () => {
    const source = await Bun.file(new URL('../marketplace/catalog.ts', import.meta.url)).text();

    expect(source).not.toContain('process.env.MANAGED_GIT_GITHUB_TOKEN');
  });
});
