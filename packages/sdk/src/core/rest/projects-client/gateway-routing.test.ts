import { beforeEach, expect, mock, test } from "bun:test";
import { configureKortix } from "../../http/config";
import {
  getGatewayRoutingPolicy,
  previewGatewayRoute,
  resetGatewayRoutingPolicy,
  setGatewayRoutingPolicy,
} from "./gateway";

let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(
    async (url: unknown, opts: { method?: string; body?: string } = {}) => {
      calls.push({
        url: String(url),
        method: opts.method ?? "GET",
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
      return new Response(
        JSON.stringify({
          version: 1,
          project: {},
          effective: {},
          platform: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  ) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: "http://test.local",
  getToken: async () => "tok",
});
const last = () => calls[calls.length - 1];

test("routing policy transport supports get, whole-document set, reset, and preview", async () => {
  await getGatewayRoutingPolicy("P1");
  expect(last()).toMatchObject({
    url: expect.stringContaining("/projects/P1/gateway/routing-policy"),
    method: "GET",
  });

  const project = {
    defaultModel: "codex/gpt-5.6-sol",
    visionModel: "anthropic/claude-sonnet-4.6",
    defaultFallback: { models: ["glm-5.2"], fallbackOn: "any-error" as const },
    rules: [
      {
        model: "anthropic/claude-opus-4.8",
        fallbackModels: ["anthropic/claude-sonnet-4.6"],
        fallbackOn: "transient" as const,
      },
    ],
  };
  await setGatewayRoutingPolicy("P1", project);
  expect(last()).toMatchObject({
    url: expect.stringContaining("/projects/P1/gateway/routing-policy"),
    method: "PUT",
    body: project,
  });

  await previewGatewayRoute("P1", { requestedModel: "auto", imageInput: true });
  expect(last()).toMatchObject({
    url: expect.stringContaining("/projects/P1/gateway/routing-policy/preview"),
    method: "POST",
    body: { requestedModel: "auto", imageInput: true },
  });

  await resetGatewayRoutingPolicy("P1");
  expect(last()).toMatchObject({
    url: expect.stringContaining("/projects/P1/gateway/routing-policy"),
    method: "DELETE",
  });
});
