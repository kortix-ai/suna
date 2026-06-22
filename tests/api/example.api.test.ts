import { describe, expect, it } from "bun:test";

const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:8008/v1").replace(/\/+$/, "");
const ORIGIN = API_BASE_URL.replace(/\/v1$/, "");

describe("api/example: GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(10000) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status?: string; service?: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("kortix-api");
  });

  it("serves the versioned health route too", async () => {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(10000) });
    expect(res.status).toBe(200);
  });
});
