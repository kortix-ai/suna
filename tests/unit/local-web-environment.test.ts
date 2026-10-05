import { describe, expect, it } from "vitest";
import { localWebEnvironment } from "../src/core/local-stack";

const options = {
  webPort: 3000,
  webUrl: "http://127.0.0.1:3000",
  apiUrl: "http://127.0.0.1:8008/v1",
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseAnonKey: "anon-key",
};

describe("localWebEnvironment", () => {
  // The regression this guards: Turbopack's dev filesystem cache is default-ON
  // since Next 16.1. A failed restore panics outside turbo-tasks' per-task
  // panic boundary and aborts the dev server:
  //
  //   thread 'tokio-rt-worker' panicked at
  //     turbo-tasks-backend/src/backend/operation/mod.rs:292:17:
  //   Restore of All for task TaskId 7979517 failed in another thread
  //
  // Every browser spec scheduled after that point then failed with
  // ERR_CONNECTION_REFUSED and reported ITSELF as the failure. A one-shot CI
  // job starts with a cold cache and deletes it afterwards, so it gains
  // nothing from the cache and loses a whole shard when the abort lands.
  it("turns off the Turbopack dev filesystem cache", () => {
    expect(localWebEnvironment(options).KORTIX_TURBOPACK_FS_CACHE).toBe("off");
  });

  it("points the web app at the local api, supabase, and its own origin", () => {
    const env = localWebEnvironment(options);
    expect(env.NEXT_PUBLIC_BACKEND_URL).toBe("http://127.0.0.1:8008/v1");
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    expect(env.WEB_PORT).toBe("3000");
  });

  // The proxy target is the API ORIGIN, not the versioned base the SDK uses.
  // Passing the /v1 suffix through would make every proxied path /v1/v1/....
  it("strips the /v1 suffix from the proxy target", () => {
    expect(localWebEnvironment(options).KORTIX_API_PROXY_TARGET).toBe(
      "http://127.0.0.1:8008",
    );
  });

  it("disables billing so the deterministic profile never reaches Stripe", () => {
    expect(localWebEnvironment(options).NEXT_PUBLIC_BILLING_ENABLED).toBe(
      "false",
    );
  });
});
