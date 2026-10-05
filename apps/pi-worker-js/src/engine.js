// THE CELL'S AGENT ENGINE: pi 1.0's durable harness (`@earendil-works/pi-durable`)
// hosted in the cell's Durable Object.
//
// Everything the branch used to hand-roll — the turn queue and its alarm
// claim, the op ledger keyed by toolCallId, the transcript-as-context window,
// compaction — is pi-durable's now, and stronger:
//
//  - every phase of a run is checkpointed in the object's SQLite before it
//    proceeds, so an evicted isolate resumes the run (a cut-off model request
//    is resent, a `replay: "safe"` tool re-runs, an interrupted unsafe tool is
//    reported to the model as interrupted instead of run twice);
//  - a submission's `requestId` is the Kortix message id, so a redelivered
//    prompt is the same submission, exactly once;
//  - compaction and retry are pi's own.
//
// What stays the cell's: which tools exist (CodingTools over the cell's own
// tree or an attached machine, plus glob, todo, machine and the project's
// plugins), what the system prompt says, which model the gateway serves, and
// the Kortix wire (kortix/turn-events.js) that every client renders.
import { Harness, createRegistry, defineExtension, defineTool, section, watchEvents, UserEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openPiStorage } from "./do-sqlite.js";
import { DurableTurnEvents } from "./kortix/turn-events.js";

const BG = BACKGROUND_CONTEXT;
export const KORTIX_PROVIDER_ID = "kortix";
const FAUX_PROVIDER_ID = "faux";

/** The cell's own turn bookkeeping: one row per admitted user message. */
export const TURNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kx_turns (
  message_id    TEXT PRIMARY KEY,
  submission_id TEXT,
  status        TEXT NOT NULL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  relayed       INTEGER NOT NULL DEFAULT 0
)`;

/** `kortix/<id>` and bare `<id>` both name the gateway model `<id>`. */
export function nativeModelId(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const id = raw.startsWith(`${KORTIX_PROVIDER_ID}/`) ? raw.slice(KORTIX_PROVIDER_ID.length + 1) : raw;
  return id || null;
}

/**
 * A gateway model as pi-ai describes it: the Kortix LLM gateway's
 * OpenAI-completions surface, exactly as kortixd's pi harness registers it
 * (harness/pi/model.ts `gatewayModel`). The catalog only sizes the window; a
 * model it does not list still routes.
 */
export function gatewayModel(id, baseUrl, entry = undefined) {
  return {
    id,
    name: entry?.name ?? id,
    api: "openai-completions",
    provider: KORTIX_PROVIDER_ID,
    baseUrl,
    reasoning: entry?.reasoning === true,
    input: entry?.attachment ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry?.limit?.context ?? 128_000,
    maxTokens: entry?.limit?.output ?? 32_768,
    compat: { thinkingFormat: "openai", supportsStore: false, supportsDeveloperRole: false },
  };
}

/**
 * Lift a pi-agent-core style tool (`execute(id, args, signal, onUpdate, ctx)`)
 * into a pi-durable registration. The cell's glob, todo, machine and plugin
 * tools are written in that shape; this is the one adapter between the two.
 */
export function fromAgentTool(tool, { replay = "unsafe" } = {}) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay,
    async execute(args, api, context) {
      const onUpdate = (partial) => {
        const text = (partial?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
        if (text) api.output(text);
      };
      const r = await tool.execute(api.callId, args, context?.abortSignal, onUpdate, { env: api.env });
      return {
        content: Array.isArray(r?.content) ? r.content : [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r ?? null) }],
        ...(r?.details !== undefined ? { details: r.details } : {}),
        ...(r?.isError ? { isError: true } : {}),
      };
    },
  });
}

/**
 * A scripted model, for suites and local runs with no gateway: each step is
 * `{text}` or `{tool, args}` (or `{tools: [{tool, args}]}` for one round of
 * parallel calls). Offline, deterministic, free.
 */
export function scriptSteps(script) {
  return (Array.isArray(script) ? script : []).map((step) => {
    if (step?.tools) return fauxAssistantMessage(step.tools.map((t) => fauxToolCall(t.tool, t.args ?? {})), { stopReason: "toolUse" });
    if (step?.tool) return fauxAssistantMessage(fauxToolCall(step.tool, step.args ?? {}), { stopReason: "toolUse" });
    return fauxAssistantMessage(String(step?.text ?? ""));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorText = (e) => String(e?.message ?? e);

export class CellEngine {
  /**
   * @param {object} o
   * @param {object} o.storage        the Durable Object's `ctx.storage`
   * @param {object} o.sql            `ctx.storage.sql`, for the cell's own tables
   * @param {string} o.rootId         the Kortix runtime root (`ses_pi…`)
   * @param {string} o.workspace      /workspace
   * @param {(frames: object[]) => void} o.publish     frames to the bus and the transcript
   * @param {() => Record<string,string>} o.env        the session's effective env
   * @param {(target: object) => Promise<object>} o.envFor  the ExecutionEnv tools run in
   * @param {() => Promise<{system: string, instructions: string, skills: string, shell: string}>} o.prompt
   * @param {() => Promise<object[]>} o.tools           extra pi-durable tools for the next run
   * @param {() => string} o.mintMessageId
   * @param {() => string} o.agentName
   * @param {(turn: object) => void} o.onTurnEnd
   * @param {(frame: object) => void} [o.onFrame]
   * @param {(...a: unknown[]) => void} [o.log]
   */
  constructor(o) {
    this.o = o;
    this.sql = o.sql;
    this.sql.exec(TURNS_TABLE_SQL);
    this.log = o.log ?? (() => {});
    this.credentials = new InMemoryCredentialStore();
    // An auth context with no file system and no ambient environment: keys
    // come from the session's own env, never from a dynamic `node:` import
    // pi-ai would otherwise attempt (a cell has no fs to look in).
    this.models = createModels({
      credentials: this.credentials,
      authContext: { env: async (name) => this.o.env()[name], fileExists: async () => false },
    });
    this.registry = createRegistry();
    this.registry.install(CodingTools);
    this.registry.install(defineExtension({ name: "kortix-prompt", sections: this.#sections() }));
    this.gatewayModels = new Map();
    this.faux = null;
  }

  // ── model access ───────────────────────────────────────────────────────

  /** Faux for suites (`CELL_MODEL=faux`), else the Kortix LLM gateway. */
  get scripted() {
    const env = this.o.env();
    return env.CELL_MODEL === "faux" || (!env.KORTIX_LLM_BASE_URL && !env.CELL_MODEL);
  }

  /** The model this session runs: the control plane's choice, then the compiled agent's, then the default. */
  selectedModelId() {
    const env = this.o.env();
    return nativeModelId(this.requestedModel) ?? nativeModelId(env.KORTIX_MODEL) ?? nativeModelId(env.KORTIX_AGENT_MODEL) ?? nativeModelId(env.KORTIX_DEFAULT_MODEL) ?? "deepseek-v4-flash";
  }

  /** `{providerID, modelID}` for the wire. */
  modelRef() {
    if (this.scripted) return { providerID: FAUX_PROVIDER_ID, modelID: this.faux?.getModel().id ?? "faux" };
    return { providerID: KORTIX_PROVIDER_ID, modelID: this.selectedModelId() };
  }

  /** Register what the next run needs with pi-ai, and answer its ModelRef. */
  async ensureModel() {
    if (this.scripted) {
      if (!this.faux) {
        this.faux = fauxProvider({ provider: FAUX_PROVIDER_ID });
        this.models.setProvider(this.faux.provider);
      }
      const script = this.o.env().SCRIPT;
      if (script && this.faux.getPendingResponseCount() === 0) {
        try { this.faux.setResponses(scriptSteps(JSON.parse(script))); } catch { /* a bad script answers nothing */ }
      }
      const m = this.faux.getModel();
      return { provider: m.provider, modelId: m.id };
    }
    const env = this.o.env();
    const baseUrl = String(env.KORTIX_LLM_BASE_URL ?? "").replace(/\/+$/, "");
    const token = String(env.KORTIX_TOKEN ?? "").trim();
    if (!baseUrl || !token) throw new Error("the cell needs KORTIX_LLM_BASE_URL and KORTIX_TOKEN (the Kortix LLM gateway)");
    const id = this.selectedModelId();
    if (this.gatewayBase !== baseUrl || !this.gatewayModels.has(id)) {
      if (this.gatewayBase !== baseUrl) this.gatewayModels.clear();
      this.gatewayBase = baseUrl;
      this.gatewayModels.set(id, gatewayModel(id, baseUrl));
      this.models.setProvider(createProvider({
        id: KORTIX_PROVIDER_ID,
        name: "Kortix",
        baseUrl,
        auth: { apiKey: envApiKeyAuth("Kortix gateway token", ["KORTIX_PI_GATEWAY_KEY"]) },
        models: [...this.gatewayModels.values()],
        api: { "openai-completions": openAICompletionsApi() },
      }));
    }
    if (this.gatewayToken !== token) {
      this.gatewayToken = token;
      await this.credentials.modify(KORTIX_PROVIDER_ID, async () => ({ type: "api_key", key: token }));
    }
    return { provider: KORTIX_PROVIDER_ID, modelId: id };
  }

  /** Steps for the scripted model, for a suite driving a cell. */
  script(steps) {
    if (!this.faux) {
      this.faux = fauxProvider({ provider: FAUX_PROVIDER_ID });
      this.models.setProvider(this.faux.provider);
    }
    this.faux.setResponses(scriptSteps(steps));
  }

  // ── the system prompt ──────────────────────────────────────────────────

  #sections() {
    const part = (key) => async () => {
      try {
        const parts = await this.o.prompt();
        return parts?.[key] || undefined;
      } catch (e) {
        this.log("prompt", key, errorText(e));
        return undefined;
      }
    };
    return [
      section("kortix", part("system"), { tag: false }),
      section("environment", part("shell"), { tag: false }),
      section("project", part("instructions"), { tag: false }),
      section("skills", part("skills"), { tag: false }),
    ];
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** Open the harness over the object's SQLite. Idempotent; a failed open is retried by the next caller. */
  open() {
    this.opening ??= (async () => {
      const t0 = Date.now();
      const model = await this.ensureModel();
      const storage = await openPiStorage(this.o.storage);
      const harness = await Harness.open(storage, {
        models: this.models,
        registry: this.registry,
        // Each progress commit is a durable write on celld; a slightly slower
        // cadence than pi's 100 ms default costs nothing a reader can see.
        settings: { progress: { partialIntervalMs: 150, outputIntervalMs: 250 } },
        env: (target) => this.o.envFor(target),
        onReport: (e) => this.log("report", errorText(e)),
      }, BG);
      const root = await harness.root(BG, { agent: { model, cwd: this.o.workspace } });
      this.harness = harness;
      this.root = root;
      this.configuredModel = `${model.provider}/${model.modelId}`;
      await this.#watch();
      harness.resume();
      this.openedMs = Date.now() - t0;
      return this;
    })().catch((e) => {
      this.opening = null;
      throw e;
    });
    return this.opening;
  }

  async close() {
    const h = this.harness;
    this.harness = null;
    this.root = null;
    this.opening = null;
    await this.stream?.stop().catch(() => {});
    this.stream = null;
    await h?.close(BG).catch(() => {});
  }

  async #watch() {
    this.translator = new DurableTurnEvents({
      sessionID: typeof this.o.rootId === "function" ? this.o.rootId() : this.o.rootId,
      workspace: this.o.workspace,
      mintMessageId: () => this.o.mintMessageId(),
      parentMessageId: () => this.parentMessageId,
      model: () => this.modelRef(),
      agent: () => this.o.agentName(),
    });
    const stream = await watchEvents(this.harness, this.root.id, BG);
    this.stream = stream;
    stream.start(async (events) => {
      try {
        await this.#onBatch(events);
      } catch (e) {
        this.log("watch", errorText(e));
      }
    });
  }

  async #onBatch(events) {
    const frames = [];
    const ended = [];
    for (const event of events) {
      if (event.type === "snapshot") continue;
      if (event.type === "run_start") await this.#runStarted(event.inputs ?? []);
      if (event.type === "compaction_start") frames.push(...(this.o.onCompaction?.("start", event) ?? []));
      if (event.type === "compaction_end") frames.push(...(this.o.onCompaction?.("end", event) ?? []));
      frames.push(...this.translator.translate(event));
      if (event.type === "run_end") ended.push({ inputs: event.inputs ?? [], error: this.translator.error });
    }
    if (frames.length) this.o.publish(frames);
    for (const end of ended) await this.#runEnded(end);
  }

  /** Which user messages a run answers; the last one is the assistant's parent. */
  async #messageIdsOf(submissionIds) {
    const out = [];
    for (const id of submissionIds) {
      const row = this.sql.exec("SELECT message_id FROM kx_turns WHERE submission_id = ?", String(id)).toArray()[0];
      if (row?.message_id) { out.push(row.message_id); continue; }
      const sub = await this.harness?.submission(id, BG).catch(() => null);
      const record = sub ? await sub.status(BG).catch(() => null) : null;
      if (record?.requestId) out.push(record.requestId);
    }
    return out;
  }

  async #runStarted(inputs) {
    const ids = await this.#messageIdsOf(inputs);
    this.parentMessageId = ids.at(-1) ?? this.parentMessageId ?? null;
    for (const id of ids) this.sql.exec("UPDATE kx_turns SET status = 'running', started_at = ? WHERE message_id = ?", Date.now(), id);
  }

  async #runEnded({ inputs, error }) {
    const ids = await this.#messageIdsOf(inputs);
    const aborted = error?.code === "aborted";
    const status = error && !aborted ? "error" : "done";
    for (const id of ids) {
      this.sql.exec(
        "UPDATE kx_turns SET status = ?, error = ?, ended_at = ?, relayed = 0 WHERE message_id = ?",
        status, error ? JSON.stringify(error) : null, Date.now(), id,
      );
      this.o.onTurnEnd({ messageId: id, status: status === "error" ? "error" : "idle", error: error ?? null });
    }
  }

  // ── turns ──────────────────────────────────────────────────────────────

  /**
   * Admit a prompt. The user message is published by the caller before this;
   * pi gets the text (and images the model can read) under the message id as
   * its `requestId`, so a redelivery is the same submission.
   */
  async submit({ messageId, content, model, noReply = false }) {
    await this.open();
    const known = this.sql.exec("SELECT status FROM kx_turns WHERE message_id = ?", messageId).toArray()[0];
    if (known) return { deduplicated: true };
    if (model) this.requestedModel = model;
    const ref = await this.ensureModel();
    const refKey = `${ref.provider}/${ref.modelId}`;
    if (refKey !== this.configuredModel) {
      await this.root.configure({ model: ref }, BG);
      this.configuredModel = refKey;
    }
    await this.#installTools();
    this.sql.exec(
      "INSERT INTO kx_turns(message_id, status, created_at) VALUES (?, ?, ?)",
      messageId, noReply ? "done" : "queued", Date.now(),
    );
    const submission = noReply
      ? await this.root.submit({ type: "write", requestId: messageId, entry: { kind: UserEntry.kind, model: [{ role: "user", content, timestamp: Date.now() }] } }, BG)
      : await this.root.submit({ type: "input", requestId: messageId, content, whenBusy: "followUp" }, BG);
    this.sql.exec("UPDATE kx_turns SET submission_id = ? WHERE message_id = ?", String(submission.id), messageId);
    return { deduplicated: false, submissionId: submission.id };
  }

  /** The cell's extra tools, re-read before every prompt (plugins come from the checkout). */
  async #installTools() {
    try {
      const tools = await this.o.tools();
      this.registry.install(defineExtension({ name: "kortix-tools", tools }));
    } catch (e) {
      this.log("tools", errorText(e));
    }
  }

  /** Stop the running work. Resolves when pi says the conversation is idle, or after `ms`. */
  async abort(ms = 8_000) {
    if (!this.root) return false;
    const ctl = new AbortController();
    const done = this.root.abort(withAbortSignal(ctl.signal, BG)).then(() => true, () => false);
    const timer = sleep(ms).then(() => { ctl.abort(); return false; });
    return Promise.race([done, timer]);
  }

  /** pi's own manual compaction; the summary lands at the next boundary. */
  async compact(instructions) {
    await this.open();
    return this.root.compact(instructions || undefined, BG);
  }

  /** Whether pi has live work: a run, a queued input, a compaction. */
  async busy() {
    if (!this.harness) return this.sql.exec("SELECT COUNT(*) AS n FROM kx_turns WHERE status IN ('queued', 'running')").toArray()[0].n > 0;
    const inspection = await this.harness.inspect(BG);
    return inspection.tasks.length > 0 || inspection.submissions.length > 0;
  }

  /** Wait for idle, bounded. True when idle. */
  async waitForIdle(ms) {
    await this.open();
    const ctl = new AbortController();
    const idle = this.root.waitForIdle(withAbortSignal(ctl.signal, BG)).then(() => true, () => false);
    const timer = sleep(ms).then(() => { ctl.abort(); return false; });
    return Promise.race([idle, timer]);
  }

  /** One turn, by its user message id. */
  turn(messageId) {
    return this.sql.exec("SELECT * FROM kx_turns WHERE message_id = ?", messageId).toArray()[0] ?? null;
  }

  latestTurn() {
    return this.sql.exec("SELECT * FROM kx_turns ORDER BY created_at DESC LIMIT 1").toArray()[0] ?? null;
  }

  activeTurn() {
    return this.sql.exec("SELECT * FROM kx_turns WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1").toArray()[0] ?? null;
  }

  unrelayedTurns() {
    return this.sql.exec("SELECT * FROM kx_turns WHERE status IN ('done', 'error') AND relayed = 0 ORDER BY ended_at").toArray();
  }

  markRelayed(messageId) {
    this.sql.exec("UPDATE kx_turns SET relayed = 1 WHERE message_id = ?", messageId);
  }
}
