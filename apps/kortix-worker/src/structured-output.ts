import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { OutputFormat, StructuredOutputError } from "@opencode-ai/sdk/v2";

function validator(schema: Record<string, unknown>) {
  const engine =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : Ajv;
  const check = new engine({
    strict: false,
    allErrors: false,
    coerceTypes: false,
  }).compile(schema);
  if ("$async" in check)
    throw new Error("asynchronous schemas are not supported");
  return check;
}

export function parseOutputFormat(value: unknown): OutputFormat {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("format must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.type === "text" &&
    Object.keys(input).every((key) => key === "type")
  )
    return { type: "text" };
  if (
    input.type !== "json_schema" ||
    Object.keys(input).some(
      (key) => !["type", "schema", "retryCount"].includes(key),
    )
  ) {
    throw new Error("format must specify text or json_schema");
  }
  if (
    !input.schema ||
    typeof input.schema !== "object" ||
    Array.isArray(input.schema)
  ) {
    throw new Error("format.schema must be a JSON Schema object");
  }
  if (
    input.retryCount !== undefined &&
    (!Number.isSafeInteger(input.retryCount) ||
      (input.retryCount as number) < 0)
  ) {
    throw new Error("format.retryCount must be a non-negative safe integer");
  }
  try {
    validator(input.schema as Record<string, unknown>);
  } catch (error) {
    throw new Error(`format.schema is invalid: ${(error as Error).message}`);
  }
  return structuredClone(input) as OutputFormat;
}

export function installStructuredOutput(agent: Agent) {
  let active: Extract<OutputFormat, { type: "json_schema" }> | null = null;
  let currentAssistant: any = null;
  let failures = 0;
  let finished = false;
  const values = new Map<string, unknown>();
  const error = (message: string): StructuredOutputError => ({
    name: "StructuredOutputError",
    data: { message, retries: Math.max(0, failures - 1) },
  });
  const fail = (message: string) => {
    finished = true;
    if (currentAssistant)
      currentAssistant.kortixStructuredOutputError = error(message);
  };
  const originalPayload = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const next: any = (await originalPayload?.(payload, model)) ?? payload;
    return active && model.api === "openai-completions" && next?.tools?.length
      ? { ...next, tool_choice: "required" }
      : next;
  };
  const originalBefore = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) =>
    active && finished
      ? {
          block: true,
          terminate: true,
          reason: "The structured output request has finished.",
        }
      : originalBefore?.(context, signal);
  const originalStop = agent.shouldStopAfterTurn;
  agent.shouldStopAfterTurn = async (context, signal) => {
    const customStop = await originalStop?.(context, signal);
    return Boolean(active && finished) || Boolean(customStop);
  };
  agent.subscribe((event: any, signal) => {
    if (!active || event.kortixCachedToolReplay) return;
    if (event.type === "message_end" && event.message.role === "assistant") {
      currentAssistant = event.message;
      if (
        event.message.stopReason === "stop" &&
        !event.message.content.some((part: any) => part.type === "toolCall")
      ) {
        fail("Model did not produce structured output");
      }
    }
    if (
      event.type !== "tool_execution_end" ||
      event.toolName !== "StructuredOutput"
    )
      return;
    if (signal.aborted) return;
    if (finished) {
      values.delete(event.toolCallId);
      event.result.terminate = true;
      return;
    }
    if (!event.isError && values.has(event.toolCallId)) {
      currentAssistant.kortixStructured = values.get(event.toolCallId);
      finished = true;
    } else {
      failures++;
      if (failures > (active.retryCount ?? 2))
        fail(
          "Model did not produce valid structured output within the retry budget",
        );
    }
    values.delete(event.toolCallId);
    if (finished) event.result.terminate = true;
  });
  return {
    begin(format?: OutputFormat, previous: readonly any[] = []) {
      active = format?.type === "json_schema" ? format : null;
      currentAssistant = null;
      finished = false;
      failures = previous.filter(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "StructuredOutput" &&
          message.isError,
      ).length;
      values.clear();
      if (!active) return;
      const check = validator(active.schema);
      const { $schema: _schema, ...parameters } = active.schema;
      agent.state.systemPrompt +=
        "\nThe user requires structured output. Use StructuredOutput for your final answer, after completing any other tools. Plain text is not a valid final answer.";
      agent.state.tools = [
        ...agent.state.tools,
        {
          name: "StructuredOutput",
          label: "Structured output",
          description:
            "Return the final answer matching the requested JSON schema. Call this tool after all other work is complete.",
          parameters: parameters as any,
          async execute(id, args) {
            if (!check(args))
              throw new Error(
                `Structured output does not match the schema: ${JSON.stringify(check.errors)}`,
              );
            const value = structuredClone(args);
            values.set(id, value);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
              details: { valid: true },
            };
          },
        },
      ];
    },
    missingError(): StructuredOutputError | null {
      const lastAssistant = agent.state.messages.findLast(
        (message) => message.role === "assistant",
      );
      if (
        !active ||
        finished ||
        ["error", "aborted", "length"].includes(
          (lastAssistant as any)?.stopReason,
        )
      )
        return null;
      return error("The agent stopped before producing structured output");
    },
    end() {
      active = null;
      currentAssistant = null;
      values.clear();
    },
  };
}
