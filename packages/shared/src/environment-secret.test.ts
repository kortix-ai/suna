import { afterEach, describe, expect, test } from "bun:test";

import { hydrateEnvironmentSecret } from "./environment-secret";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("hydrateEnvironmentSecret", () => {
  test("hydrates string values and removes the aggregate secret", () => {
    process.env.KORTIX_ENV_JSON = JSON.stringify({
      DATABASE_URL: "postgres://example",
      OPTIONAL_PROVIDER_TOKEN: "token",
    });

    expect(hydrateEnvironmentSecret()).toBe(2);
    expect(process.env.DATABASE_URL).toBe("postgres://example");
    expect(process.env.OPTIONAL_PROVIDER_TOKEN).toBe("token");
    expect(process.env.KORTIX_ENV_JSON).toBeUndefined();
  });

  test("keeps explicit task environment overrides", () => {
    process.env.KORTIX_VERSION = "0.12.4";
    process.env.KORTIX_ENV_JSON = JSON.stringify({ KORTIX_VERSION: "stale" });

    expect(hydrateEnvironmentSecret()).toBe(0);
    expect(process.env.KORTIX_VERSION).toBe("0.12.4");
  });

  test("rejects malformed or non-string secret values", () => {
    process.env.KORTIX_ENV_JSON = "not-json";
    expect(() => hydrateEnvironmentSecret()).toThrow("KORTIX_ENV_JSON must contain a JSON object");

    process.env.KORTIX_ENV_JSON = JSON.stringify({ PORT: 8000 });
    expect(() => hydrateEnvironmentSecret()).toThrow('KORTIX_ENV_JSON key "PORT" must be a string');
  });
});
