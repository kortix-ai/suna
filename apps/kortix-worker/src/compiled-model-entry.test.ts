import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function bootModel(compiledModel: string, environmentModel?: string, limits?: { baked?: { model: string; context: number; output: number }; override?: { model: string; context: number; output: number } }) {
  const requests: any[] = [];
  const gateway = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as any;
      requests.push(body);
      const frame = {
        id: "compiled-model",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "MODEL_SELECTED" },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-compiled-model-"));
  const entry = path.join(directory, "entry.mjs");
  const compiled = {
    manifest: { default_agent: "build" },
    modelLimits: limits?.baked,
    agentConfig: {
      model: compiledModel,
      agent: { build: { model: compiledModel, prompt: "Follow the user." } },
    },
  };
  await writeFile(
    entry,
    `globalThis.__KORTIX_COMPILED__=${JSON.stringify(compiled)};await import(${JSON.stringify(new URL("./main.ts", import.meta.url).href)});`,
  );
  const child = Bun.spawn([process.execPath, entry], {
    env: {
      PATH: process.env.PATH,
      KORTIX_SERVICE_PORT: "0",
      KORTIX_ENV_URL: "http://127.0.0.1:1",
      KORTIX_ENV_CWD: "/workspace",
      KORTIX_LLM_BASE_URL: gateway.url.toString().replace(/\/$/, "") + "/v1",
      KORTIX_TOKEN: "compiled-model-fixture",
      KORTIX_SESSION_ID: "compiled-model-entry",
      ...(environmentModel ? { KORTIX_MODEL: environmentModel } : {}),
      ...(limits?.override ? { KORTIX_MODEL_LIMITS: JSON.stringify(limits.override) } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    let output = "";
    let port: number | undefined;
    while (!port) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error(
          `Worker did not start: ${output} ${await new Response(child.stderr).text()}`,
        );
      output += new TextDecoder().decode(chunk.value);
      for (const line of output.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.msg === "worker listening") port = value.port;
        } catch {}
      }
    }
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: "Bearer compiled-model-fixture",
      "content-type": "application/json",
    };
    const sessions = (await (
      await fetch(base + "/session", { headers })
    ).json()) as any[];
    const response = await fetch(base + `/session/${sessions[0].id}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parts: [{ type: "text", text: "Reply MODEL_SELECTED." }],
      }),
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as any;
    expect(answer.info.error).toBeUndefined();
    expect(
      answer.parts.some(
        (part: any) => part.type === "text" && part.text === "MODEL_SELECTED",
      ),
    ).toBe(true);
    expect(requests).toHaveLength(1);
    const health = await (await fetch(base + "/kortix/health", { headers })).json() as any;
    return { request: requests[0], answer, health };
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    child.kill();
    await child.exited;
    gateway.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

for (const model of ["gpt-5.6-luna", "kortix/gpt-5.6-luna", "openai/gpt-4.1"]) {
  test(`the compiled entry sends ${model} through the configured gateway`, async () => {
    const { request, answer } = await bootModel(model);
    const native = model.replace(/^kortix\//, "");
    expect(request.model).toBe(native);
    expect(answer.info.modelID).toBe(native);
    expect(answer.info.providerID).toBe("kortix");
  });
}

test("an explicit session model takes precedence over a short compiled model", async () => {
  const { request, answer } = await bootModel("gpt-5.6-luna", "openai/gpt-4.1");
  expect(request.model).toBe("openai/gpt-4.1");
  expect(answer.info.modelID).toBe("openai/gpt-4.1");
});


test('a compiled gateway alias uses its own context and output limits', async () => {
  const { health } = await bootModel('kortix/gpt-5.6-luna', undefined, {
    baked: { model: 'gpt-5.6-luna', context: 1050000, output: 128000 },
  });
  expect(health.model_context_window).toBe(1050000);
  expect(health.model_max_output).toBe(128000);
});

test('an explicit model uses its override limits rather than the compiled model limits', async () => {
  const { health } = await bootModel('gpt-5.6-luna', 'openai/gpt-4.1', {
    baked: { model: 'gpt-5.6-luna', context: 1050000, output: 128000 },
    override: { model: 'openai/gpt-4.1', context: 1047576, output: 32768 },
  });
  expect(health.model_context_window).toBe(1047576);
});

test('an unknown gateway alias does not inherit the first provider catalog context window', async () => {
  const { health } = await bootModel('unknown-test-alias');
  expect(health.model_context_window).toBeNull();
});
