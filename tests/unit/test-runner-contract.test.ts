import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
const rootPackage = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const testsPackage = JSON.parse(
  readFileSync(resolve(root, "tests/package.json"), "utf8"),
);

describe("local test runner contract", () => {
  it("uses the committed Bun lockfile for installation and test commands", () => {
    expect(existsSync(resolve(root, "tests/bun.lock"))).toBe(true);
    expect(existsSync(resolve(root, "tests/package-lock.json"))).toBe(false);
    expect(makefile).toMatch(
      /TEST_RUN\s*:=\s*cd\s+\$\(TESTS\)\s*&&\s*bun\s+run/,
    );
    expect(makefile).toMatch(
      /cd\s+\$\(TESTS\)\s*&&\s*bun\s+install\s+--frozen-lockfile/,
    );
    expect(makefile).toMatch(
      /cd\s+\$\(TESTS\)\s*&&\s*bunx\s+playwright\s+install\s+--with-deps\s+chromium/,
    );
    expect(makefile).not.toContain("npm --prefix $(TESTS)");
  });

  it("exposes one local-first flow command from the repository root", () => {
    expect(rootPackage.scripts["test:flows"]).toBe(
      "dotenvx run -f apps/api/.env -- bun tests/bin/ke2e.ts local",
    );
    expect(testsPackage.scripts["test:flows"]).toBe("bun bin/ke2e.ts local");
  });
});
