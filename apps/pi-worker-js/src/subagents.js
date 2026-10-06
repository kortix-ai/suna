// SUBAGENTS: OpenCode's `task` tool, in a cell, on pi-durable conversations.
//
// kortixd's pi harness ships `task` (harness/pi/extensions/subagents.ts): the
// input `{ description, prompt, subagent_type, task_id? }`, the child session
// id in the running part's `metadata.sessionId` (the web's TaskTool preview
// links the child from it), and an output that starts `task_id: <id>` so the
// model can resume the child. Types: `general`, `explore` (read-only), and
// every compiled agent whose `mode` is `subagent` or `all`. Children get no
// `task` (no nesting) and no `question` (nobody answers a child).
//
// The cell keeps that contract and runs each child as its OWN pi-durable
// conversation in the same Durable Object:
//   - the child's run is checkpointed like the root's, so an evicted isolate
//     resumes it;
//   - `task` is registered `replay: "safe"`: an interrupted call re-runs, finds
//     its child and user message in a per-call memo, and re-submits under the
//     same `requestId`, which pi-durable answers with the same submission;
//   - the child's events are translated under the child's session id, into
//     the child's own transcript, so the client streams and reads the child as
//     it does an OpenCode subagent.
import { defineTool, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { DurableTurnEvents, entryMessage } from "./kortix/turn-events.js";

const BG = BACKGROUND_CONTEXT;

export const CHILDREN_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kx_children (
  session_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,   -- pi-durable ConversationId (a number), as text
  agent           TEXT NOT NULL,
  title           TEXT NOT NULL,
  system_prompt   TEXT NOT NULL,
  permission      TEXT,
  model           TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)`;

const SUBAGENT_PROMPT = [
  "You are a subagent working inside a Kortix sandbox. Another agent delegated one task to you.",
  "Complete the task end to end with the tools you have. Your final message is returned to that agent, not shown to the user: make it a concise, complete report of what you did and found.",
].join("\n");

const BUILT_IN = {
  general: {
    description: "General-purpose agent for researching complex questions and executing multi-step tasks. Use it to run independent units of work.",
    prompt: SUBAGENT_PROMPT,
  },
  explore: {
    description: "Fast read-only agent for exploring the workspace: find files by pattern, search code, and answer questions about the codebase. It cannot edit files.",
    prompt: `${SUBAGENT_PROMPT}\nYou are read-only: search and read, never change files.`,
    tools: ["bash", "read", "glob", "grep"],
  },
};

/** The tools a child never gets: no nesting, and nobody answers a child's question. */
export const CHILD_EXCLUDED_TOOLS = ["task", "question"];

/** kortixd's `subagentTypes`: the built-ins, then the compiled agents marked subagent or all. */
export function subagentTypes(agents = {}) {
  const types = new Map(Object.entries(BUILT_IN));
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || agent.disable === true || (agent.mode !== "subagent" && agent.mode !== "all")) continue;
    types.set(name, {
      description: agent.description ?? `The ${name} agent.`,
      prompt: (typeof agent.prompt === "string" && agent.prompt.trim()) || SUBAGENT_PROMPT,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.permission !== undefined ? { permission: agent.permission } : {}),
    });
  }
  return types;
}

export const TASK_PARAMETERS = Type.Object({
  description: Type.String({ description: "A short (3-5 words) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform" }),
  subagent_type: Type.String({ description: "The type of specialized agent to use for this task" }),
  task_id: Type.Optional(Type.String({ description: "Set only to resume a previous task: the task_id a previous task output returned" })),
});

export function describeTask(types) {
  return [
    "Launch a subagent to handle a complex, multi-step task on its own, with a fresh context. The subagent returns one final report.",
    "",
    "Available agent types:",
    ...[...types].map(([name, type]) => `- ${name}: ${type.description}`),
    "",
    "Usage:",
    "- Always set subagent_type to one of the types above.",
    "- Write a complete prompt: the subagent sees nothing of this conversation.",
    "- Launch several subagents in one message when their work is independent.",
    "- The result is not shown to the user; summarize what matters in your own reply.",
    "- To continue a previous task with its context, pass the task_id its output returned.",
  ].join("\n");
}

/** The text of an assistant entry. */
const assistantText = (entry) => {
  const message = entryMessage(entry, "assistant");
  return { message, text: (message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("") };
};

export class CellSubagents {
  /**
   * @param {object} o
   * @param {object} o.sql
   * @param {import("./engine.js").CellEngine} o.engine
   * @param {() => string} o.rootId
   * @param {() => string} o.mintMessageId
   * @param {(rootId: string, nonce: string) => Promise<string>} o.mintChildId
   * @param {(frames: object[]) => void} o.publish
   * @param {() => object} o.compiledAgents   the compiled config's `agent` map
   * @param {() => string} o.workspace
   * @param {(...a: unknown[]) => void} [o.log]
   */
  constructor(o) {
    this.o = o;
    this.sql = o.sql;
    this.sql.exec(CHILDREN_TABLE_SQL);
    this.watchers = new Map();
  }

  row(sessionId) {
    return this.sql.exec("SELECT * FROM kx_children WHERE session_id = ?", sessionId).toArray()[0] ?? null;
  }

  byConversation(conversationId) {
    return this.sql.exec("SELECT * FROM kx_children WHERE conversation_id = ?", String(conversationId)).toArray()[0] ?? null;
  }

  all() {
    return this.sql.exec("SELECT * FROM kx_children ORDER BY created_at").toArray();
  }

  setStatus(sessionId, status) {
    this.sql.exec("UPDATE kx_children SET status = ?, updated_at = ? WHERE session_id = ?", status, Date.now(), sessionId);
  }

  /** The `task` tool, registered for pi-durable. Its description lists the current subagent types. */
  tool() {
    const types = subagentTypes(this.o.compiledAgents());
    return defineTool({
      name: "task",
      description: describeTask(types),
      parameters: TASK_PARAMETERS,
      replay: "safe",
      executionMode: "parallel",
      execute: (args, api, context) => this.#execute(args, api, context),
    });
  }

  async #execute(args, api, context) {
    const types = subagentTypes(this.o.compiledAgents());
    const type = types.get(args.subagent_type);
    if (!type) throw new Error(`Unknown subagent_type "${args.subagent_type}". Available: ${[...types.keys()].join(", ")}.`);
    const result = await this.spawn({
      ...(args.task_id ? { sessionId: args.task_id } : {}),
      title: `${args.description} (@${args.subagent_type} subagent)`,
      agent: args.subagent_type,
      systemPrompt: type.prompt,
      ...(type.model ? { model: type.model } : {}),
      ...(type.tools ? { tools: type.tools } : {}),
      ...(type.permission !== undefined ? { permission: type.permission } : {}),
      prompt: args.prompt,
    }, api, context);
    if (result.status === "aborted") throw new Error(`The subagent was aborted. task_id: ${result.sessionId}`);
    const body = result.status === "error"
      ? `<task_error>\n${result.error ?? "The subagent failed."}\n</task_error>`
      : `<task_result>\n${result.text}\n</task_result>`;
    return {
      content: [{ type: "text", text: `task_id: ${result.sessionId} (for resuming to continue this task if needed)\n\n${body}` }],
      details: { sessionId: result.sessionId, model: result.model },
    };
  }

  /** Run one prompt in a child conversation (new, or the one `sessionId` names) and return its final answer. */
  async spawn(input, api, context) {
    const engine = this.o.engine;
    await engine.open();
    const harness = engine.harness;
    const rootId = this.o.rootId();
    // Per call, durable: the child and the user message this call created.
    let call = await api.memo("kortix.task", context);
    let row = call ? this.row(call.sessionId) : null;
    if (!row && input.sessionId) {
      row = this.row(input.sessionId);
      if (!row) throw new Error(`task_id ${input.sessionId} is not a subagent session of this session`);
      if (row.status === "busy") throw new Error(`task_id ${row.session_id} is already running`);
    }
    const modelRef = input.model ? await engine.modelRefFor(input.model) : await engine.ensureModel();
    const model = { providerID: modelRef.provider, modelID: modelRef.modelId };
    if (!row) {
      const createdAt = Date.now();
      const sessionId = await this.o.mintChildId(rootId, this.o.mintMessageId());
      const offered = (await api.agent(context)).tools
        .filter((t) => !CHILD_EXCLUDED_TOOLS.includes(t.name) && (!input.tools || input.tools.includes(t.name)));
      const conversation = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: modelRef, tools: offered, cwd: this.o.workspace() },
      }, BG);
      this.sql.exec(
        "INSERT INTO kx_children(session_id, conversation_id, agent, title, system_prompt, permission, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
        sessionId, String(conversation.id), input.agent, input.title, input.systemPrompt,
        input.permission === undefined ? null : JSON.stringify(input.permission), `${model.providerID}/${model.modelID}`, createdAt, createdAt,
      );
      row = this.row(sessionId);
      this.o.publish([{ type: "session.created", properties: { sessionID: sessionId, info: this.sessionObject(row) } }]);
    }
    if (!call || call.sessionId !== row.session_id) {
      call = await api.memo("kortix.task", { sessionId: row.session_id, messageId: this.o.mintMessageId() }, context);
      row = this.row(call.sessionId) ?? row;
    }
    const sessionId = row.session_id;
    const conversation = await harness.conversation(Number(row.conversation_id), BG);
    if (!conversation) throw new Error(`the subagent session ${sessionId} has no conversation`);
    await this.#watch(row, call.messageId, model);
    // The running part links the child at once (the web reads metadata.sessionId).
    await api.details({ sessionId, model }, context).catch(() => {});
    this.o.publish(this.#userMessage(sessionId, call.messageId, input.prompt, input.agent, model));
    this.setStatus(sessionId, "busy");
    let settled;
    try {
      const submission = await conversation.submit({ type: "input", requestId: call.messageId, content: input.prompt, whenBusy: "followUp" }, BG);
      settled = await awaitWithContext(submission.wait(BG), context);
    } catch (e) {
      if (context?.abortSignal?.aborted) {
        await conversation.abort(BG).catch(() => {});
        this.setStatus(sessionId, "idle");
        return { sessionId, status: "aborted", text: "", model };
      }
      this.setStatus(sessionId, "idle");
      return { sessionId, status: "error", text: "", error: String(e?.message ?? e), model };
    }
    this.setStatus(sessionId, "idle");
    if (settled.status !== "done") {
      return { sessionId, status: "error", text: "", error: settled.detail ?? settled.reason ?? "The subagent did not answer.", model };
    }
    const answer = await conversation.commit((tx) => tx.entry(settled.answer), BG);
    const { message, text } = assistantText(answer);
    if (message?.stopReason === "aborted") return { sessionId, status: "aborted", text, model };
    if (message?.stopReason === "error" || message?.stopReason === "length") {
      return { sessionId, status: "error", text, error: message.errorMessage || (message.stopReason === "length" ? "The subagent hit the output length limit." : "The model request failed."), model };
    }
    return { sessionId, status: "completed", text, model };
  }

  /** The child's user message, as the client reads it. Idempotent: the same id upserts. */
  #userMessage(sessionId, messageId, text, agent, model) {
    const created = Date.now();
    return [
      { type: "message.updated", properties: { sessionID: sessionId, info: { id: messageId, role: "user", sessionID: sessionId, time: { created }, agent, model } } },
      { type: "message.part.updated", properties: { sessionID: sessionId, time: created, part: { id: `${messageId}-p0`, messageID: messageId, sessionID: sessionId, type: "text", text } } },
    ];
  }

  /** The child's pi-durable events, translated under the child's session id. One watcher per child per isolate. */
  async #watch(row, parentMessageId, model) {
    const existing = this.watchers.get(row.session_id);
    if (existing) { existing.parent = parentMessageId; return; }
    const state = { parent: parentMessageId, stream: null };
    this.watchers.set(row.session_id, state);
    const translator = new DurableTurnEvents({
      sessionID: row.session_id,
      workspace: this.o.workspace(),
      mintMessageId: () => this.o.mintMessageId(),
      parentMessageId: () => state.parent,
      model: () => model,
      agent: () => row.agent,
    });
    try {
      state.stream = await watchEvents(this.o.engine.harness, Number(row.conversation_id), BG);
    } catch (e) {
      this.watchers.delete(row.session_id);
      throw e;
    }
    state.stream.start(async (events) => {
      try {
        const frames = [];
        for (const event of events) {
          if (event.type === "snapshot") continue;
          frames.push(...translator.translate(event));
        }
        if (frames.length) this.o.publish(frames);
      } catch (e) {
        this.o.log?.("subagent", row.session_id, String(e?.message ?? e));
      }
    });
  }

  /** Abort every child that is running: a Stop on the root reaches its subagents. */
  async abortAll() {
    const harness = this.o.engine.harness;
    if (!harness) return;
    for (const row of this.all().filter((r) => r.status === "busy")) {
      const conversation = await harness.conversation(Number(row.conversation_id), BG).catch(() => null);
      await conversation?.abort(BG).catch(() => {});
      this.setStatus(row.session_id, "idle");
    }
  }

  async close() {
    for (const state of this.watchers.values()) await state.stream?.stop().catch(() => {});
    this.watchers.clear();
  }

  /** The child in the client's session shape: the root's, with its own id, title and parent. */
  sessionObject(row, base = {}) {
    return { ...base, id: row.session_id, slug: row.session_id, parentID: this.o.rootId(), title: row.title, time: { created: Number(row.created_at), updated: Number(row.updated_at) } };
  }
}
