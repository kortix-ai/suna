import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("runtime update command proves promotion and rollback from a real process", async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const child = Bun.spawn(
    [process.execPath, join(directory, "runtime-update-demo.mjs")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("served during build:      v1");
  expect(stdout).toContain("candidate promoted:       true");
  expect(stdout).toContain("after promotion:          v2");
  expect(stdout).toContain("unhealthy promoted:       false");
  expect(stdout).toContain("active after failure:     v2");
});
