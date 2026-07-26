import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getMaintenanceConfig,
  getUserRolesWithToken,
  setMaintenanceConfig,
} from "./maintenance";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  requests.splice(0);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json({
      level: "none",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("maintenance host transport", () => {
  test("reads maintenance state anonymously from the normalized API URL", async () => {
    const result = await getMaintenanceConfig<{ level: string }>({
      backendUrl: "https://api.example.test",
      cache: "no-store",
    });

    expect(result.level).toBe("none");
    expect(requests[0]?.url).toBe(
      "https://api.example.test/v1/system/maintenance",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(new Headers(requests[0]?.init?.headers).has("Authorization")).toBe(
      false,
    );
  });

  test("writes maintenance state with the explicit bearer token", async () => {
    const config = {
      level: "blocking",
      updatedAt: "2026-07-26T00:00:00.000Z",
    };

    await setMaintenanceConfig(config, {
      backendUrl: "https://api.example.test/v1/",
      accessToken: "maintenance-token",
    });

    expect(requests[0]?.url).toBe(
      "https://api.example.test/v1/system/maintenance",
    );
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(requests[0]?.init?.body).toBe(JSON.stringify(config));
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer maintenance-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("checks the caller role with the same explicit bearer token", async () => {
    await getUserRolesWithToken({
      backendUrl: "https://api.example.test/v1",
      accessToken: "maintenance-token",
    });

    expect(requests[0]?.url).toBe("https://api.example.test/v1/user-roles");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer maintenance-token",
    );
  });
});
