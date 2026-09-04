import { describe, expect, it } from "vitest";
import { supabaseAdminHeaders } from "../src/core/supabase-admin";

describe("supabaseAdminHeaders", () => {
  it("sends a new opaque secret key only as the API key", () => {
    expect(
      supabaseAdminHeaders("sb_secret_current", {
        anonKey: "legacy-anon",
        json: true,
      }),
    ).toEqual({
      apikey: "sb_secret_current",
      "content-type": "application/json",
    });
  });

  it("preserves the legacy anon plus service-role JWT contract", () => {
    expect(
      supabaseAdminHeaders("legacy.service.role", {
        anonKey: "legacy-anon",
        json: true,
      }),
    ).toEqual({
      apikey: "legacy-anon",
      authorization: "Bearer legacy.service.role",
      "content-type": "application/json",
    });
  });

  it("uses the legacy service-role JWT as the API key when no anon key is supplied", () => {
    expect(supabaseAdminHeaders("legacy.service.role")).toEqual({
      apikey: "legacy.service.role",
      authorization: "Bearer legacy.service.role",
    });
  });
});
