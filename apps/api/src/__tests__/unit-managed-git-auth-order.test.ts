import { describe, expect, test } from "bun:test";

describe("managed GitHub authentication", () => {
  test("contains no legacy PAT or GitHub App token resolver", async () => {
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
    expect(resolver).not.toContain("managedGithubToken");
    expect(resolver).not.toContain("createInstallationToken");
    expect(resolver).not.toContain("app_installation");
    expect(resolver).toContain("resolveNangoProjectGitAuth");
  });

  test('does not reuse managed Git credentials for marketplace reads', async () => {
    const source = await Bun.file(new URL('../marketplace/catalog.ts', import.meta.url)).text();

    expect(source).not.toContain('process.env.MANAGED_GIT_GITHUB_TOKEN');
  });
});
