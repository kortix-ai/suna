// THE SCRIPTED MODEL — a fixed sequence of turns, in its own module.
//
// Split out of model.js because model.js imports the bare specifier
// "agent-providers", which only resolves through build.mjs's esbuild alias. That
// is fine inside the bundle and fatal outside it: test/local-pi.mjs runs the
// same agent under plain node, and importing model.js there fails with
// ERR_MODULE_NOT_FOUND before a single measurement is taken.
//
// Deterministic, offline, free — and it exercises the entire machinery that is
// actually ours: the tool call, the round trip, the ledger, the persistence.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 };

function baseMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "scripted",
    model: model?.id ?? "scripted",
    usage: { ...EMPTY_USAGE },
    stopReason: "stop",
  };
}

/**
 * Build a streamFn from a list of turns. Each turn is either
 *   { text: "..." }                              → a plain assistant reply
 *   { tool: "bash", args: { command: "..." } }   → one tool call
 *
 * A turn may also carry `usage: {input, output, cacheRead, cacheWrite}`. Real
 * providers report it on every assistant message and the cell records it as the
 * session's actual bill; without it here, nothing could test that the recording
 * happens at all — only that the arithmetic over hand-inserted rows is right.
 *
 * Turns are consumed in order, one per model round trip. When the script runs
 * out it replies with a fixed closing line, so the loop always terminates rather
 * than spinning — a scripted model that never stops is an infinite bill in the
 * shape of a test.
 */
export function scriptedStream(turns) {
  let i = 0;
  return async (model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    const turn = turns[i++] ?? { text: "done" };
    const msg = baseMessage(model);

    // Emitted asynchronously: the agent loop subscribes to the stream after this
    // function returns, and pushing everything synchronously would race that.
    queueMicrotask(() => {
      stream.push({ type: "start", partial: msg });
      if (turn.tool) {
        const call = {
          type: "toolCall",
          // Stable per (session, turn index) so a REPLAYED script produces the
          // same op ids — which is exactly the condition the daemon's
          // idempotency cache exists to handle.
          id: turn.id ?? `call_${i}`,
          name: turn.tool,
          arguments: turn.args ?? {},
        };
        msg.content.push(call);
        msg.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: msg });
      } else {
        const text = { type: "text", text: turn.text ?? "" };
        msg.content.push(text);
        msg.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: msg });
      }
      if (turn.usage) msg.usage = { ...EMPTY_USAGE, ...turn.usage };
      stream.push({ type: "done", reason: msg.stopReason, message: msg });
      stream.end(msg);
    });

    return stream;
  };
}

