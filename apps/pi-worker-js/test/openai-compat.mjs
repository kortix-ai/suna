// A LOCAL OPENAI-COMPATIBLE SERVER, standing in for the Kortix LLM gateway.
//
// The cell's production model path is pi-ai's openai-completions provider
// pointed at KORTIX_LLM_BASE_URL with the session's KORTIX_TOKEN as the bearer
// (engine.js `ensureModel`, the same registration kortixd's pi harness makes).
// The faux provider the other suites use skips all of it. This mock speaks
// exactly enough of the chat-completions streaming API for a real turn —
// a tool call, then text — and RECORDS every request, so a suite can assert
// what the model was actually sent: the model id, the bearer, the tool list
// and the system prompt.
//
// Not a suite. Imported by suites (startGatewayMock), or run on its own
// (`node test/openai-compat.mjs`, PORT, default 7099) to point a cell at it by
// hand. No API key, no spend.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * The default answer: a `bash` tool call on the first request, text once a
 * tool result is in the conversation.
 */
export function defaultReply(body) {
  const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
  return hasToolResult
    ? { text: "ran it via the openai provider" }
    : { tool: "bash", args: { command: "echo OPENAI_PATH_OK > from-openai.txt && cat from-openai.txt" } };
}

/**
 * Start the mock. `reply(body, n)` answers request n (0-based) with
 * `{ text }` or `{ tool, args }`; the default is defaultReply.
 * Resolves `{ url, seen, close }`: `url` is the base a cell takes as
 * KORTIX_LLM_BASE_URL, `seen` holds `{ path, auth, body }` per request.
 */
export async function startGatewayMock({ reply = defaultReply, port = 0, host = "127.0.0.1" } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const n = seen.length;
      seen.push({ path: req.url, auth: req.headers.authorization ?? null, body });
      const step = reply(body, n) ?? { text: "ok" };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const base = { id: `chatcmpl-mock-${n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "mock" };
      if (step.tool) {
        // Streamed the way the real API streams a tool call: the function name
        // in the first delta, the arguments as a JSON string.
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_mock_${n}`, type: "function", function: { name: step.tool, arguments: "" } }] }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args ?? {}) } }] }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: { content: String(step.text ?? "") }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      sse(res, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${server.address().port}/v1`;
  return { url, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The system prompt a recorded request carried, as one string. */
export function systemPromptOf(body) {
  const m = (body?.messages ?? []).find((x) => x.role === "system" || x.role === "developer");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c?.text ?? "").join("");
}

/** The tool names a recorded request offered the model. */
export const toolNamesOf = (body) => (body?.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startGatewayMock({ port: Number(process.env.PORT ?? 7099), host: "0.0.0.0" });
  console.log(`[openai-mock] ${mock.url.replace("0.0.0.0", "127.0.0.1")}`);
  process.on("SIGTERM", () => process.exit(0));
}
