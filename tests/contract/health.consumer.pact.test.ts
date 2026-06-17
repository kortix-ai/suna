import { afterAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { MatchersV3, PactV3 } from "@pact-foundation/pact";

const { like, string } = MatchersV3;
const here = import.meta.dirname;

const provider = new PactV3({
  consumer: "kortix-dashboard",
  provider: "kortix-api",
  dir: resolve(here, "pacts"),
  logLevel: "warn",
});

describe("contract: kortix-api health", () => {
  it("GET /v1/health responds with a healthy service body", async () => {
    provider
      .given("the api is healthy")
      .uponReceiving("a request for service health")
      .withRequest({ method: "GET", path: "/v1/health" })
      .willRespondWith({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: like({
          status: string("ok"),
          service: string("kortix-api"),
          version: like("1.0.0"),
        }),
      });

    await provider.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/v1/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; service: string };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("kortix-api");
    });
  });
});

afterAll(() => {
  console.log(`pact written → ${resolve(here, "pacts")}`);
});
