import { describe, expect, test } from "bun:test";

describe("session read latency boundary", () => {
  test("session list and detail routes do not contact sandbox runtimes", async () => {
    const source = await Bun.file(
      new URL("../projects/routes/r7.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("syncOpenCodeTitlesForSessions");
  });
});
