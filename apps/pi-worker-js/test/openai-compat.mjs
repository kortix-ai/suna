// A LOCAL OPENAI-COMPATIBLE SERVER, so "you can point this at ChatGPT" is a
// measurement rather than a claim.
//
// The interesting question is not whether OpenAI is up. It is whether pi-ai's
// openai-completions provider — running INSIDE a V8 isolate, bundled for a
// worker target — actually drives our remote tools: does it emit a tool call
// the agent loop understands, does the daemon run it, does the result come back
// in the shape the provider expects on the next turn.
//
// This answers that with no API key and no spend. It speaks exactly enough of
// the chat-completions API to do so, and the cell cannot tell it apart from the
// real thing: same wire format, same base_url mechanism, same provider code.
//
// Turn 1: ask for a tool call.  Turn 2 (once a tool result is in the
// transcript): reply with text and stop.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 7099);
const seen = [];

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    // Did a tool result already come back? Then this is the second turn.
    const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "mock" };

    if (!hasToolResult) {
      // A tool call, streamed the way the real API streams one: the function
      // name in the first delta, arguments as a JSON string.
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo OPENAI_PATH_OK > from-openai.txt && cat from-openai.txt" }) } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const text = "ran it via the openai provider";
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, "0.0.0.0", () => console.log(`[openai-mock] :${PORT}`));

process.on("SIGTERM", () => process.exit(0));
