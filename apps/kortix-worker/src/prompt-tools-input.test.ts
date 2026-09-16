import { expect, test } from "bun:test";
import { parsePromptInput } from "./prompt-input.ts";

const controls: Record<string, boolean>[] = [
  {},
  { bash: false, read: true },
  { "*": false, question: true },
];

test.each(controls)("preserves the prompt tool controls %j", (tools) => {
  expect(
    parsePromptInput(
      JSON.stringify({ tools, parts: [{ type: "text", text: "Hi" }] }),
      {},
    ),
  ).toEqual({ ok: true, value: { text: "Hi", tools } });
});

test.each(
  [
    null,
    false,
    42,
    [],
    "bash",
    { bash: "false" },
    { bash: null },
    { "": true },
  ].map((tools) => [tools]),
)("rejects malformed prompt tool controls %j", (tools) => {
  expect(
    parsePromptInput(
      JSON.stringify({ tools, parts: [{ type: "text", text: "Hi" }] }),
      {},
    ),
  ).toEqual({
    ok: false,
    error: "tools must map non-empty permission names to booleans",
  });
});
