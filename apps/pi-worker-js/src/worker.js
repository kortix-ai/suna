// THE PI CELL — a Kortix session runtime that is a Durable Object.
//
// One cell is one Kortix session. Its agent is pi 1.0's durable harness
// (engine.js) running in a V8 isolate with no filesystem and no processes; its
// state — pi's checkpoints, the transcript, the workspace tree, the session's
// env — is the object's own SQLite, which celld replicates to object storage.
// An evicted isolate comes back from that and resumes a run mid-turn.
//
// TO THE PLATFORM IT IS A KORTIXD PI BOX. The API, the SDK, the web app and the
// CLI talk to it exactly as they talk to the sandbox daemon running the pi
// harness (apps/kortix-sandbox-agent-server, KORTIX_HARNESS=pi):
//
//   /kortix/health, /kortix/env, /kortix/abort, /kortix/runtime/*   (control)
//   /global/event, /session/*, /permission, /question, …             (OpenCode surface)
//   /file/*, /find/*, /kortix/pty, /kortix/git/commit-push           (workspace)
//   POST {KORTIX_API_URL}/projects/:p/turn-stream                     (callbacks)
//
// with the same root session id (`ses_pi` + sha256 of the Kortix session), the
// same message ids, the same event framing and the same transcript shapes. So
// nothing outside this directory needs to know a session is a cell.
//
// A STRICT atob IS WHY A CHATGPT SUBSCRIPTION DID NOT WORK IN A CELL: pi's
// Codex provider decodes an unpadded base64url JWT segment with atob, and the
// isolate's atob implements the spec and throws. Pad it first.
const nativeAtob = globalThis.atob;
globalThis.atob = (input) => {
  let s = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const rem = s.length % 4;
  if (rem === 2) s += "==";
  else if (rem === 3) s += "=";
  else if (rem === 1) return nativeAtob(input);
  return nativeAtob(s);
};

import { CELL_CWD, cellExecutionEnv, cellFs, cellShellNote, runCapture } from "./execenv.cell.js";
import { envRpcExecutionEnv, mintUserContext } from "./execenv.envrpc.js";
import { CellEngine, fromAgentTool, nativeModelId } from "./engine.js";
import { KortixEventBus, globalEventStream, runtimeEventStream } from "./kortix/bus.js";
import { TranscriptStore } from "./kortix/transcript.js";
import { MESSAGE_ID, MessageIdClock, ROOT_ID, mintRootId } from "./kortix/ids.js";
import { decodeDataUrl, stripInlineAttachmentBytes } from "./kortix/attachments.js";
import { turnErrorCode } from "./kortix/turn-events.js";
import { CELL_VERSION, parsePromptBody } from "./kortix/prompt.js";
import { filesAnswer } from "./cell-files.js";
import { STATIC_PREFIX, staticAnswer } from "./cell-static.js";
import { loadWorkspaceSkills, withSkills } from "./skills.js";
import { workspaceConfigDir } from "./manifest.js";
import { ENVIRONMENT_TABLE_SQL, attachEnvironment, readCached as readEnvironment, waitForRepo } from "./environment.js";
import { machineTool } from "./machine-tool.js";
import { machineFs, machineGit } from "./machine-fs.js";
import { isPluginFile, loadPlugins, pluginsDirFor, pluginsSummary, toPiTool } from "./plugins.js";
import { collectWorkspace, createNodeRuntime, seedRuntime } from "./nodejs.js";
import { globTool, readTodos, todoTools } from "./plantools.js";
import { grepTool } from "./fstools.js";
import { agentList, agentModelId, agentSystemPrompt, parseAgentConfig, selectAgent } from "./agent-config.js";
import { agentNameFrom, agentShape, bootAnswer } from "./opencode-boot.js";
import { cloneProject, commitAndPush, fileDiffs, isCheckedOut, workingStatus } from "./cell-git.js";
import { banner, cdTarget, feed, newEditor, prompt, ptyCreate, ptyGet, ptyList, ptyRemove, ptySetCwd, ptyUpdate } from "./cell-pty.js";


/** kortixd's default pi prompt, for a project whose compiled agent has none. */
const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding agent working inside a Kortix session. The project repository is checked out at the working directory.",
  "Use the tools to read, search and change files and to run commands. Prefer small, verifiable steps. Report what you did and what remains.",
].join("\n");

/** How much of AGENTS.md joins the system prompt. Enough for instructions, not a book. */
const PROJECT_INSTRUCTIONS_MAX = 16_000;

/** kortixd's runtime capability names a pi session advertises; one `session.*` is required. */
const CAPABILITIES = ["file.import", "file.append", "runtime.turns.v1", "session.compact"];

/** The longest one alarm waits on pi; a longer run is waited on across several alarms. */
const ALARM_WAIT_MS = 10 * 60_000;
/** The alarm that restarts the object if it is evicted while pi works. */
const DEADMAN_MS = 30_000;

const json = (status, body, headers = {}) => Response.json(body, { status, headers });
const notFound = (path) => json(404, { error: `no pi cell handler for ${path}` });
const decodeSegment = (value) => { try { return decodeURIComponent(value); } catch { return null; } };
const errorText = (e) => String(e?.message ?? e);

export class AgentCell {
  constructor(state, env) {
    this.state = state;
    this.env = env ?? {};
    this.sql = state.storage.sql;
    this.instance = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.bornAt = Date.now();
    this.bus = new KortixEventBus({ epoch: this.instance });
    this.clock = new MessageIdClock();
    this.ready = false;
  }

  // ── state ──────────────────────────────────────────────────────────────

  init() {
    if (this.ready) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS session_env (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS userenv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sessionEnv = {};
    for (const row of this.sql.exec("SELECT k, v FROM session_env")) this.sessionEnv[String(row.k)] = String(row.v);
    this.transcript = new TranscriptStore(this.sql);
    for (const m of this.transcript.all()) this.clock.observe(m.info.id);
    this.#closeInterruptedMessages();
    this.ready = true;
  }

  meta(k) {
    return this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  setMeta(k, v) {
    if (v === null || v === undefined) this.sql.exec("DELETE FROM meta WHERE k = ?", k);
    else this.sql.exec("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }

  /** The node's env (CELLD_VAR_*), with what the control plane pushed for this session over it. */
  effectiveEnv() {
    return { ...this.env, ...this.sessionEnv };
  }

  get rootId() {
    return this.meta("root_id");
  }

  /** The root this object serves: named by the router, else derived from the session. */
  async adoptRoot(fromRouter) {
    if (this.rootId) return this.rootId;
    const session = this.effectiveEnv().KORTIX_SESSION_ID;
    const root = fromRouter && ROOT_ID.test(fromRouter) ? fromRouter : session ? await mintRootId(session) : null;
    if (root) {
      this.setMeta("root_id", root);
      if (!this.meta("created_at")) this.setMeta("created_at", Date.now());
    }
    return root;
  }

  /** A previous isolate died mid-message: the message is finished, as aborted. */
  #closeInterruptedMessages() {
    for (const m of this.transcript.all()) {
      if (m.info.role === "assistant" && !m.info.time?.completed && !m.info.error) {
        this.transcript.apply({ type: "message.updated", properties: { sessionID: m.info.sessionID, info: { ...m.info, time: { ...m.info.time, completed: Date.now() }, error: { name: "MessageAbortedError", data: { message: "The cell restarted during this message; the turn resumed in a new message" }, code: "aborted" } } } });
      }
    }
    this.transcript.flush();
  }

  // ── the agent ──────────────────────────────────────────────────────────

  agentConfig() {
    const e = this.effectiveEnv();
    const raw = typeof e.KORTIX_COMPILED_AGENT_CONFIG === "string" ? e.KORTIX_COMPILED_AGENT_CONFIG : "";
    const wanted = agentNameFrom(e);
    if (this.__agentRaw !== raw || this.__agentWanted !== wanted) {
      const config = parseAgentConfig(raw);
      this.__agent = { config, ...selectAgent(config, wanted) };
      this.__agentRaw = raw;
      this.__agentWanted = wanted;
    }
    return this.__agent;
  }

  agentName() {
    return this.agentConfig().name ?? agentNameFrom(this.effectiveEnv());
  }

  /** The env pi's model resolution reads: the compiled agent's model under the control plane's. */
  modelEnv() {
    const e = this.effectiveEnv();
    const { agent, config } = this.agentConfig();
    const model = agentModelId(agent, config);
    return model ? { ...e, KORTIX_AGENT_MODEL: model } : e;
  }

  engine() {
    if (this.__engine) return this.__engine;
    this.__engine = new CellEngine({
      storage: this.state.storage,
      sql: this.sql,
      rootId: () => this.rootId,
      workspace: CELL_CWD,
      env: () => this.modelEnv(),
      publish: (frames) => this.publish(frames),
      envFor: (target) => this.toolEnv(target?.cwd),
      prompt: () => this.promptParts(),
      tools: () => this.extraTools(),
      mintMessageId: () => this.clock.mint(),
      agentName: () => this.agentName(),
      onTurnEnd: () => { this.relayPending().catch(() => {}); },
      onCompaction: (phase) => this.compactionFrames(phase),
      log: (...a) => this.log(...a),
    });
    return this.__engine;
  }

  log(...parts) {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    this.logs ??= [];
    this.logs.push(`${new Date().toISOString()} ${line}`);
    if (this.logs.length > 400) this.logs.shift();
  }

  /** Every frame goes on the bus AND into the transcript; one flush per batch. */
  publish(frames) {
    for (const frame of frames) {
      if (!frame?.type) continue;
      this.transcript.apply(frame);
      if (!frame.transcriptOnly) this.bus.publish(frame.type, frame.properties, frame.properties?.sessionID);
    }
    this.transcript.flush();
    if (frames.some((f) => f.type === "message.updated" || f.type === "session.idle")) this.touch();
  }

  touch() {
    this.setMeta("updated_at", Date.now());
  }

  sessionObject() {
    const created = Number(this.meta("created_at")) || this.bornAt;
    const updated = Number(this.meta("updated_at")) || created;
    const compacting = Number(this.meta("compacting_at")) || null;
    return {
      id: this.rootId,
      slug: this.rootId,
      projectID: String(this.effectiveEnv().KORTIX_PROJECT_ID ?? "").trim() || this.effectiveEnv().KORTIX_SESSION_ID || this.rootId,
      directory: CELL_CWD,
      title: this.meta("title") ?? "New session",
      version: CELL_VERSION,
      time: { created, updated, ...(compacting ? { compacting } : {}) },
    };
  }

  /** kortixd's compaction wire: `time.compacting` on the session while it runs, then `session.compacted`. */
  compactionFrames(phase) {
    const sessionID = this.rootId;
    if (phase === "start") {
      this.setMeta("compacting_at", Date.now());
      return [{ type: "session.updated", properties: { sessionID, info: this.sessionObject() } }];
    }
    this.setMeta("compacting_at", null);
    return [
      { type: "session.updated", properties: { sessionID, info: this.sessionObject() } },
      { type: "session.compacted", properties: { sessionID } },
    ];
  }

  // ── the workspace ──────────────────────────────────────────────────────

  cell() {
    if (!this.cellFs) {
      this.cellFs = cellFs(this.sql);
      // Every changed path goes out as `file.edited`, so the Files panel, git
      // status and an open viewer re-read.
      this.cellFs.onChange = (paths) => this.publish(paths.slice(0, 50).map((file) => ({ type: "file.edited", properties: { file } })));
    }
    this.cellFs.shellEnv = this.projectSecrets();
    return this.cellFs;
  }

  /** The project's own secrets for the agent's shell; the control plane's KORTIX_* never. */
  projectSecrets() {
    const names = String(this.meta("project_env_names") ?? "").split(",").filter(Boolean);
    const e = this.effectiveEnv();
    const out = {};
    for (const n of names) if (!/^KORTIX_|^CELLD_/.test(n) && typeof e[n] === "string") out[n] = e[n];
    for (const r of this.sql.exec("SELECT k, v FROM userenv")) out[r.k] = r.v;
    return out;
  }

  /** The ExecutionEnv tools run in: the attached machine, else the cell's own tree. */
  async toolEnv(cwd) {
    const machine = await this.machineEnv();
    if (machine) return machine;
    return cellExecutionEnv(this.cell(), cwd ?? CELL_CWD);
  }

  /** The project's checkout, once per cell, started off the critical path. */
  prewarmCheckout() {
    if (this.__prewarmed || !String(this.effectiveEnv().KORTIX_REPO_URL ?? "").trim()) return;
    this.__prewarmed = true;
    this.ensureCheckout().catch(() => null);
  }

  async ensureCheckout() {
    if (this.__checkoutOk) return this.__checkoutOk;
    this.__checkoutInFlight ??= this.#checkoutOnce()
      .then((r) => { if (r?.ok) this.__checkoutOk = r; return r; })
      .finally(() => { this.__checkoutInFlight = null; });
    return this.__checkoutInFlight;
  }

  async #checkoutOnce() {
    const e = this.effectiveEnv();
    const url = typeof e.KORTIX_REPO_URL === "string" ? e.KORTIX_REPO_URL.trim() : "";
    if (!url) return { ok: false, reason: "no repo url" };
    const cell = this.cell();
    await cell.ready;
    if (await isCheckedOut(cell.fs)) return { ok: true, cloned: false };
    const started = Date.now();
    const ref = String(e.KORTIX_BRANCH_NAME ?? "").trim() || String(e.KORTIX_BASE_REF ?? "").trim() || undefined;
    let r = await cloneProject({ cell, url, ref, token: e.KORTIX_TOKEN });
    // A fresh session's branch may not exist on the origin yet: clone the base.
    if (!r.ok && ref && e.KORTIX_BASE_REF && ref !== e.KORTIX_BASE_REF) r = await cloneProject({ cell, url, ref: String(e.KORTIX_BASE_REF).trim(), token: e.KORTIX_TOKEN });
    this.log("checkout", { ok: r.ok, cloned: r.cloned, error: r.error, ms: Date.now() - started });
    if (r.ok && r.cloned) this.publish([{ type: "file.edited", properties: { file: CELL_CWD } }]);
    return r;
  }

  async configDir() {
    if (this.__configDir) return this.__configDir;
    try { this.__configDir = await workspaceConfigDir(cellExecutionEnv(this.cell())); } catch { this.__configDir = null; }
    return this.__configDir;
  }

  async skills({ reload = false } = {}) {
    const configDir = await this.configDir();
    if (this.__skills && !reload && this.__skills.configDir === configDir) return this.__skills;
    const loaded = await loadWorkspaceSkills(this.effectiveEnv(), () => cellExecutionEnv(this.cell()), configDir);
    loaded.configDir = configDir;
    this.__skills = loaded;
    return loaded;
  }

  async projectInstructions() {
    try {
      const env = await this.toolEnv();
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const read = await env.readTextFile(name);
        const body = read?.ok ? String(read.value ?? "").trim() : "";
        if (!body) continue;
        const kept = body.length > PROJECT_INSTRUCTIONS_MAX ? `${body.slice(0, PROJECT_INSTRUCTIONS_MAX)}\n…` : body;
        return `The project's own instructions, from ${name} in the workspace. Follow them:\n\n${kept}`;
      }
    } catch { /* a workspace that cannot be read has no instructions */ }
    return "";
  }

  /** The system prompt's parts, prepared once per prompt and read by pi before each request. */
  async preparePrompt() {
    await this.ensureCheckout().catch(() => null);
    const { block } = await this.skills({ reload: !this.__skillsAfterCheckout }).catch(() => ({ block: "" }));
    this.__skillsAfterCheckout = true;
    const plugins = await this.plugins().catch(() => null);
    const machine = await this.machineEnv();
    this.__prompt = {
      system: withSkills(agentSystemPrompt(this.agentConfig().agent, DEFAULT_SYSTEM_PROMPT), plugins ? pluginsSummary(plugins) : ""),
      shell: machine ? "" : cellShellNote({ machine: this.machineAvailable() }),
      instructions: await this.projectInstructions(),
      skills: block,
    };
    return this.__prompt;
  }

  async promptParts() {
    return this.__prompt ?? this.preparePrompt();
  }

  /** glob, grep, todo, machine and the project's plugin tools, for pi-durable. */
  async extraTools() {
    const plugins = await this.plugins().catch(() => null);
    const pluginTools = (plugins?.tools ?? []).map((t) => toPiTool(t, { onError: (p, n, e) => this.log("plugin", `${p}.${n} threw: ${e?.message ?? e}`) }));
    return [
      fromAgentTool(globTool(), { replay: "safe" }),
      fromAgentTool(grepTool(), { replay: "safe" }),
      ...todoTools(this.sql, (todos) => this.publish([{ type: "todo.updated", properties: { sessionID: this.rootId, todos } }]))
        .map((t) => fromAgentTool(t, { replay: "safe" })),
      ...(this.machineAvailable() ? [fromAgentTool(this.machineTool())] : []),
      ...pluginTools.map((t) => fromAgentTool(t)),
    ];
  }

  async plugins({ reload = false } = {}) {
    if (this.__plugins && !reload) return this.__plugins;
    const configDir = await this.configDir();
    const dir = pluginsDirFor(configDir ?? ".kortix/pi");
    const cell = this.cell();
    const env = cellExecutionEnv(cell);
    const shipped = await env.listDir(dir).then((r) => (r?.ok ? (r.value ?? []).filter((e) => e.kind === "file").map((e) => e.name) : [])).catch(() => []);
    if (!shipped.some(isPluginFile)) {
      this.__plugins = { tools: [], plugins: [], diagnostics: [] };
      return this.__plugins;
    }
    await cell.ready;
    const workspace = await collectWorkspace(cell.fs, CELL_CWD).catch(() => ({ files: [], dirs: [] }));
    const collectedAt = new Map(workspace.files);
    const dec = new TextDecoder();
    const absOf = (p) => (p.startsWith("/") ? p : `${CELL_CWD}/${p}`).replace(/\/+/g, "/");
    this.__plugins = await loadPlugins({
      dir,
      readDir: async (d) => {
        const r = await env.listDir(d);
        if (!r?.ok) throw new Error(r?.error?.message ?? "no such directory");
        return (r.value ?? []).filter((e) => e.kind === "file").map((e) => e.name);
      },
      readFile: async (p) => {
        const bytes = collectedAt.get(absOf(p));
        if (bytes) return dec.decode(bytes);
        const r = await env.readTextFile(p);
        if (!r?.ok) throw new Error(r?.error?.message ?? "unreadable");
        return r.value;
      },
      runtimeFor: () => {
        const rt = createNodeRuntime({ fs: null, cwd: CELL_CWD, fetch: cell.net });
        seedRuntime(rt, workspace);
        rt.pluginContext = { project: this.effectiveEnv().KORTIX_PROJECT_ID ?? null, session: this.rootId, cwd: CELL_CWD, fetch: cell.net, log: (...m) => this.log("plugin", m.map(String).join(" ")) };
        return rt;
      },
      onProgress: (line) => this.log("plugin", line),
    }).catch(() => ({ tools: [], plugins: [], diagnostics: [] }));
    return this.__plugins;
  }

  // ── the machine ────────────────────────────────────────────────────────

  /**
   * Whether the model is offered the machine tool. The machine comes from the
   * API's `POST …/sessions/:s/environment/ensure`, which main removed with the
   * pi worker split (e60ed971f1, #9189). Until an API can provision a machine
   * for a cell again, the tool would fail on every call, so it is opt-in:
   * CELL_MACHINE=1.
   */
  machineAvailable() {
    return this.effectiveEnv().CELL_MACHINE === "1";
  }

  machineTool() {
    this.__machine ??= machineTool({
      attach: () => this.attachMachine(),
      envFor: async () => this.machineEnv(),
      workspace: () => cellExecutionEnv(this.cell()),
      onProgress: (line) => this.log("machine", line),
    });
    return this.__machine;
  }

  machineRecord() {
    try { this.sql.exec(ENVIRONMENT_TABLE_SQL); return readEnvironment(this.sql); } catch { return null; }
  }

  async machineEnv() {
    const record = this.machineRecord();
    if (!record) { this.__machineEnv = null; return null; }
    const stale = !this.__machineEnvMeta || this.__machineEnvMeta.externalId !== record.externalId || Date.now() - this.__machineEnvMeta.mintedAt > 12 * 3600_000;
    if (stale) {
      const context = await mintUserContext(record.rpcSecret, record.externalId);
      this.__machineEnv = envRpcExecutionEnv({ base: record.edge, context });
      this.__machineEnvMeta = { externalId: record.externalId, mintedAt: Date.now() };
    }
    return this.__machineEnv;
  }

  /** Attach, then make the machine the workspace: unpushed cell work is pushed and pulled first. */
  async attachMachine() {
    const r = await attachEnvironment({ env: this.effectiveEnv(), sql: this.sql, onProgress: (line) => this.log("machine", line) });
    if (!r.ok) return r;
    const env = await this.machineEnv();
    const e = this.effectiveEnv();
    const branch = String(e.KORTIX_BRANCH_NAME ?? "").trim() || null;
    this.__machineRepoReady = r.repoReady === true;
    try {
      const cell = this.cell();
      const dirty = branch && (await isCheckedOut(cell.fs)) && (await workingStatus(cell)).length > 0;
      if (dirty && !this.__machineRepoReady) this.__machineRepoReady = (await waitForRepo(r.edge)).ok;
      if (dirty) {
        const pushed = await commitAndPush({ cell, url: e.KORTIX_REPO_URL, token: e.KORTIX_TOKEN, branch, message: "Work from the session before its machine was attached" });
        this.log("machine", pushed.ok ? `pushed the session tree to ${branch}` : `could not push the session tree: ${pushed.error}`);
      }
      if (branch && (dirty || r.branch !== branch)) await machineGit(env).pull(branch);
    } catch (err) {
      this.log("machine", `sync skipped: ${errorText(err)}`);
    }
    this.__prompt = null;
    this.publish([{ type: "file.edited", properties: { file: CELL_CWD } }]);
    return r;
  }

  async machineRepoReady() {
    if (this.__machineRepoReady) return true;
    const record = this.machineRecord();
    if (!record) return false;
    this.__machineRepoReady = (await waitForRepo(record.edge)).ok;
    return this.__machineRepoReady;
  }

  /** The tree the file routes answer about: the machine's when attached, else the cell's. */
  async workspaceFs() {
    const env = await this.machineEnv();
    if (env) {
      await this.machineRepoReady();
      return { kind: "machine", fs: machineFs(env), ready: Promise.resolve(), persist: async () => {} };
    }
    return this.cell();
  }

  // ── turns ──────────────────────────────────────────────────────────────

  /** Whether the session can take a prompt: a root, and its first turn claimed when one was owed. */
  readiness() {
    const e = this.effectiveEnv();
    if (!this.rootId) return { ready: false, phase: "no-session", error: "the cell has no KORTIX_SESSION_ID" };
    const bootstrap = e.KORTIX_BOOTSTRAP_RUNTIME_SESSION === "1" || e.KORTIX_BOOTSTRAP_OPENCODE_SESSION === "1";
    if (bootstrap && !this.meta("boot_done")) return { ready: false, phase: "initial-turn-claim", error: null };
    if (this.__engineError) return { ready: false, phase: "engine", error: this.__engineError };
    return { ready: true, phase: "ready", error: null };
  }

  /**
   * Admit one prompt: publish its user message NOW (the transcript and every
   * subscriber see it before the model is called), submit it to pi under its
   * message id, and wake the alarm that drives the run.
   */
  async admit(input) {
    const messageId = input.messageId ?? this.clock.mint();
    if (this.engine().turn(messageId)) return { messageId, deduplicated: true };
    this.clock.observe(messageId);
    if (!this.meta("title")) {
      const line = input.text.trim().split("\n")[0] ?? "";
      if (line) this.setMeta("title", line.length > 80 ? `${line.slice(0, 77)}…` : line);
    }
    const created = Date.now();
    const model = nativeModelId(input.model) ?? this.engine().selectedModelId();
    const frames = [{
      type: "message.updated",
      properties: { sessionID: this.rootId, info: { id: messageId, role: "user", sessionID: this.rootId, time: { created }, agent: this.agentName(), model: { providerID: this.engine().modelRef().providerID, modelID: model, ...(input.variant ? { variant: input.variant } : {}) } } },
    }];
    let index = 0;
    if (input.text) frames.push({ type: "message.part.updated", properties: { sessionID: this.rootId, time: created, part: { id: `${messageId}-p${index++}`, messageID: messageId, sessionID: this.rootId, type: "text", text: input.text } } });
    for (const file of input.files) {
      frames.push({ type: "message.part.updated", properties: { sessionID: this.rootId, time: created, part: { id: `${messageId}-p${index++}`, messageID: messageId, sessionID: this.rootId, type: "file", mime: file.mime, url: file.url, ...(file.filename ? { filename: file.filename } : {}) } } });
    }
    this.publish(frames);
    try {
      await this.preparePrompt();
      const content = this.#content(input);
      await this.engine().submit({ messageId, content, model: input.model, noReply: input.noReply });
    } catch (e) {
      // Nothing was admitted: the user message goes, so a redelivery starts clean.
      this.publish([{ type: "message.removed", properties: { sessionID: this.rootId, messageID: messageId } }]);
      throw e;
    }
    await this.state.storage.setAlarm(Date.now() + 1);
    return { messageId, deduplicated: false };
  }

  /** pi's user content: the text, images the model may read, and a note for other attachments. */
  #content(input) {
    const images = [];
    const others = [];
    for (const f of input.files) {
      const decoded = f.mime.startsWith("image/") ? decodeDataUrl(f.url) : null;
      if (decoded) images.push({ type: "image", data: f.url.slice(f.url.indexOf(",") + 1), mimeType: f.mime });
      else others.push(`${f.filename ?? "attachment"} (${f.mime})`);
    }
    const text = others.length ? `${input.text}\n\n[attachments not shown to the model: ${others.join(", ")}]` : input.text;
    return images.length ? [{ type: "text", text }, ...images] : text;
  }

  /**
   * The ONLY signal that finalizes a turn server-side: `kind: "end"` to the
   * control plane's turn stream, with the user message the turn answered.
   * Retried until apps/api says the turn is settled; a turn that cannot be
   * relayed now is relayed by the next alarm.
   */
  async relayPending() {
    if (this.__relaying) return this.__relaying;
    this.__relaying = (async () => {
      const e = this.effectiveEnv();
      for (const turn of this.engine().unrelayedTurns()) {
        const error = turn.error ? JSON.parse(turn.error) : null;
        const body = {
          kind: "end",
          status: turn.status === "error" ? "error" : "idle",
          runtime_session_id: this.rootId,
          turn_message_id: turn.message_id,
          ...(error ? { error_name: error.name, error_message: error.data?.message, error_status: error.data?.statusCode, error_code: error.code ?? turnErrorCode({ name: error.name, statusCode: error.data?.statusCode }) } : {}),
        };
        const settled = await this.postTurnStream(body, { settle: true });
        if (settled !== false) this.engine().markRelayed(turn.message_id);
      }
    })().finally(() => { this.__relaying = null; });
    return this.__relaying;
  }

  /**
   * POST to the control plane's turn stream with the session's own token.
   * Resolves true when settled, false when it should be tried again, null
   * when there is no control plane to tell (a bench, a local cell).
   */
  async postTurnStream(frame, { settle = false, attempts = 4 } = {}) {
    const e = this.effectiveEnv();
    const apiUrl = String(e.KORTIX_API_URL ?? "").trim().replace(/\/+$/, "");
    const apiRoot = apiUrl ? (apiUrl.endsWith("/v1") ? apiUrl : `${apiUrl}/v1`) : null;
    if (!apiRoot || !e.KORTIX_PROJECT_ID || !e.KORTIX_SESSION_ID || !e.KORTIX_TOKEN) return null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(`${apiRoot}/projects/${encodeURIComponent(e.KORTIX_PROJECT_ID)}/turn-stream`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${e.KORTIX_TOKEN}` },
          body: JSON.stringify({ session_id: e.KORTIX_SESSION_ID, ...frame }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (!settle) return data ?? true;
          const outcome = data?.turn_completion?.outcome;
          if (outcome === undefined || outcome === "closed" || outcome === "already_closed" || outcome === "no_active_turn") return true;
          this.log("turn-stream", "not settled", outcome);
        } else {
          const text = await res.text().catch(() => "");
          this.log("turn-stream", res.status, text.slice(0, 200));
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return settle ? true : null;
        }
      } catch (err) {
        this.log("turn-stream", "fetch failed", errorText(err));
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    return false;
  }

  /**
   * Once per session: pin the root with the control plane, and run the first
   * turn apps/api created before this cell existed (CLI, Slack and trigger
   * sessions start with one). kortixd's boot does the same, in this order.
   */
  async boot() {
    if (this.meta("boot_done") || !this.rootId) return;
    if (this.__booting) return this.__booting;
    this.__booting = (async () => {
      await this.postTurnStream({ kind: "runtime_session", runtime_session_id: this.rootId }, { attempts: 2 });
      const e = this.effectiveEnv();
      if (e.KORTIX_BOOTSTRAP_RUNTIME_SESSION === "1" || e.KORTIX_BOOTSTRAP_OPENCODE_SESSION === "1") {
        const claim = await this.postTurnStream({ kind: "initial_turn_claim" }, { attempts: 3 });
        const turn = claim && typeof claim === "object" ? claim.initial_turn : null;
        if (turn && typeof turn.prompt === "string" && typeof turn.message_id === "string" && typeof turn.turn_token === "string") {
          try {
            const admitted = await this.admit({ messageId: turn.message_id, text: turn.prompt, files: [] });
            await this.postTurnStream({ kind: "turn_accepted", runtime_session_id: this.rootId, turn_message_id: admitted.messageId, turn_token: turn.turn_token }, { attempts: 2 });
          } catch (err) {
            this.log("boot", "initial prompt admission failed", errorText(err));
            await this.postTurnStream({ kind: "turn_abandoned", turn_token: turn.turn_token }, { attempts: 2 });
          }
        }
      }
      this.setMeta("boot_done", Date.now());
    })().finally(() => { this.__booting = null; });
    return this.__booting;
  }

  /**
   * THE ALARM DRIVES THE AGENT. celld stops an isolate's work once a response
   * is sent, so a run started by a prompt request is carried here: open pi
   * (which resumes checkpointed work after an eviction), arm a deadman alarm,
   * wait for idle, relay turn ends, re-arm while work remains.
   */
  async alarm() {
    this.init();
    await this.adoptRoot(null);
    if (!this.rootId) return;
    await this.boot().catch((e) => this.log("boot", errorText(e)));
    const engine = this.engine();
    try {
      await engine.open();
      this.__engineError = null;
    } catch (e) {
      this.__engineError = errorText(e);
      this.log("engine", "open failed", this.__engineError);
      await this.state.storage.setAlarm(Date.now() + 15_000);
      return;
    }
    if (await engine.busy()) {
      await this.state.storage.setAlarm(Date.now() + DEADMAN_MS);
      if (!this.__prompt) await this.preparePrompt().catch(() => null);
      const idle = await engine.waitForIdle(ALARM_WAIT_MS);
      await this.relayPending().catch(() => {});
      if (!idle || (await engine.busy())) {
        await this.state.storage.setAlarm(Date.now() + 1_000);
        return;
      }
    }
    await this.relayPending().catch(() => {});
    if (engine.unrelayedTurns().length) await this.state.storage.setAlarm(Date.now() + 5_000);
  }

  /** The probe behind `/kortix/health?turn=1`: the reaper and the reload gate read it. */
  turnProbe(messageId) {
    const engine = this.engine();
    const active = engine.activeTurn();
    if (!messageId) {
      const latest = engine.latestTurn();
      return { inFlight: !!active, end: active ? null : latest ? (latest.status === "error" ? "failed" : "completed") : null, orphanedPrompt: false };
    }
    const turn = engine.turn(messageId);
    if (!turn) return { inFlight: false, end: "abandoned", orphanedPrompt: true };
    if (turn.status === "queued" || turn.status === "running") return { inFlight: true, end: null, orphanedPrompt: false };
    return { inFlight: false, end: turn.status === "error" ? "failed" : "completed", orphanedPrompt: false };
  }

  // ── routes ─────────────────────────────────────────────────────────────

  async fetch(req) {
    const t0 = performance.now();
    let res;
    try {
      res = await this.handle(req);
    } catch (e) {
      this.log("route", new URL(req.url).pathname, errorText(e));
      res = json(500, { error: errorText(e) });
    }
    try { res.headers.set("x-cell-ms", (performance.now() - t0).toFixed(1)); } catch { /* sealed */ }
    return res;
  }

  async handle(req) {
    this.init();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    await this.adoptRoot(req.headers.get("x-kortix-cell-root"));
    const root = this.rootId;
    if (root && !this.meta("boot_done") && !this.__bootScheduled) {
      this.__bootScheduled = true;
      await this.state.storage.setAlarm(Date.now() + 1);
    }
    this.prewarmCheckout();

    if (path === "/ping") return json(200, { instance: this.instance, root, ageMs: Date.now() - this.bornAt, envKeys: Object.keys(this.env).sort() });

    // ── control ──────────────────────────────────────────────────────────
    if (path === "/kortix/health" && method === "GET") return this.health(url);
    if (path === "/kortix/env" && method === "POST") return this.applyEnv(req);
    if (path === "/kortix/refresh" && method === "POST") {
      await this.skills({ reload: true }).catch(() => null);
      this.__prompt = null;
      return json(200, { ok: true, repo: { before: null, after: null }, runtime: "ok", runtime_pid: null, opencode: "ok", opencode_pid: null });
    }
    if (path === "/kortix/abort" && method === "POST") {
      const aborted = await this.engine().abort().catch(() => false);
      return json(200, { ok: true, aborted, runtime_session_id: root, opencode_session_id: root });
    }
    if (path === "/kortix/config/converge" || path === "/kortix/catalog/converge" || path.startsWith("/kortix/abort/after-tool")) return notFound(path);

    // ── the Kortix runtime API (and its pre-W3 alias) ─────────────────────
    const runtime = /^\/kortix\/(?:runtime|opencode)(\/.*)$/.exec(path);
    if (runtime) return this.runtimeRoute(req, runtime[1], url, method);

    // ── the OpenCode-compatible surface ──────────────────────────────────
    if (method === "GET" && (path === "/event" || path === "/global/event")) return globalEventStream(this.bus);
    if (path === "/session" && method === "GET") {
      const r = this.readiness();
      if (!r.ready) return json(503, { code: "runtime_not_ready", error: r.error ?? "the pi cell is starting", reason: r.phase, phase: r.phase }, { "x-kortix-boot-phase": `cell|${r.phase}` });
      return json(200, [this.sessionObject()]);
    }
    if (path === "/session" && method === "POST") return json(200, this.sessionObject());
    if (path === "/session/status" && method === "GET") return json(200, this.engine().activeTurn() ? { [root]: { type: "busy" } } : {});
    const session = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (session) return this.sessionRoute(req, decodeSegment(session[1]), session[2] ?? "", url, method);

    const part = /^\/kortix\/part\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (part && method === "GET") return this.partRoute(decodeSegment(part[2]), decodeSegment(part[3]));

    if (method === "GET") {
      if (path === "/skill") {
        const { skills } = await this.skills().catch(() => ({ skills: [] }));
        return json(200, skills.map((s) => ({ name: s.name, description: s.description ?? "", location: s.filePath })));
      }
      if (path === "/tool/ids" || path === "/experimental/tool/ids") return json(200, ["read", "write", "edit", "bash", "glob", "grep", "todowrite", "todoread", ...(this.machineAvailable() ? ["machine"] : [])]);
      if (path === "/tool" || path === "/experimental/tool") return json(200, []);
      if (path === "/mcp" || path === "/lsp") return json(200, {});
      if (path === "/vcs" || path === "/vcs/status" || path === "/vcs/diff") return json(200, []);
      if (path === "/agent") {
        const { config, name } = this.agentConfig();
        const ref = this.engine().modelRef();
        return json(200, agentList(config, name, agentShape) ?? [agentShape(this.agentName(), ref.providerID, ref.modelID)]);
      }
      const ref = this.engine().modelRef();
      const boot = bootAnswer(method, path, { sessionId: root, agentName: this.agentName(), projectId: this.effectiveEnv().KORTIX_PROJECT_ID, provider: ref.providerID, modelId: ref.modelID, cwd: CELL_CWD, createdAt: Number(this.meta("created_at")) || this.bornAt, version: CELL_VERSION, checkedOut: !!this.__checkoutOk });
      if (boot) return json(boot.status, boot.body);
    }
    if (/^\/permission\/[^/]+\/reply$/.test(path) && method === "POST") return json(404, { error: "permission request not found" });
    if (/^\/question\/[^/]+\/(reply|reject)$/.test(path) && method === "POST") return json(404, { error: "question request not found" });
    if (path === "/log" && method === "POST") return json(200, true);
    if (path === "/global/dispose") return json(200, true);

    // ── the workspace ────────────────────────────────────────────────────
    if (path === "/file" || path.startsWith("/file/") || path === "/find" || path.startsWith("/find/")) return this.fileRoute(req, path, url, method);
    if (path === "/kortix/pty" || path.startsWith("/kortix/pty/")) return this.ptyRoute(req, path, method);
    if (path === "/kortix/git/commit-push" && method === "POST") return this.commitPush(req);
    if (path === "/env" && method === "GET") return json(200, { ok: true, keys: Object.keys(this.sessionEnv), secrets: Object.fromEntries([...this.sql.exec("SELECT k, v FROM userenv")].map((r) => [r.k, r.v])) });
    const envKey = /^\/env\/([^/]+)$/.exec(path);
    if (envKey && (method === "PUT" || method === "DELETE")) {
      const key = decodeSegment(envKey[1]);
      if (!key || /^KORTIX_/.test(key) || /^CELLD_/.test(key)) return json(409, { error: "reserved key" });
      if (method === "DELETE") { this.sql.exec("DELETE FROM userenv WHERE k = ?", key); return json(200, { ok: true, key, deleted: true }); }
      const body = await req.json().catch(() => ({}));
      this.sql.exec("INSERT INTO userenv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, typeof body?.value === "string" ? body.value : String(body?.value ?? ""));
      return json(200, { ok: true, key });
    }
    if (path === STATIC_PREFIX || path.startsWith(`${STATIC_PREFIX}/`)) {
      const answered = await staticAnswer(req, path, url, await this.workspaceFs());
      if (answered) return answered;
    }
    for (const p of ["/proxy", "/web-proxy", "/presentation", "/kortix/env-rpc"]) {
      if (path === p || path.startsWith(`${p}/`)) return json(501, { code: "feature_not_supported", error: `${p} is not available in a pi cell: it has no processes and no ports` });
    }

    // ── diagnostics ──────────────────────────────────────────────────────
    if (path === "/kortix/logs" || path === "/kortix/diag") return json(200, { at: new Date().toISOString(), instance: this.instance, root, logs: (this.logs ?? []).slice(-Number(url.searchParams.get("tail") ?? 200)) });
    if (path === "/cell/state") return json(200, { root, ready: this.readiness(), turns: [...this.sql.exec("SELECT * FROM kx_turns ORDER BY created_at")], messages: this.transcript.count, busy: await this.engine().busy().catch(() => null), openedMs: this.engine().openedMs ?? null });
    if (path === "/cell/script" && method === "POST" && this.effectiveEnv().CELL_TEST_ROUTES === "1") {
      const body = await req.json().catch(() => ({}));
      this.engine().script(body?.steps ?? []);
      return json(200, { ok: true });
    }
    if (req.headers.get("upgrade") === "websocket") return this.ptySocket(req, path);
    return notFound(path);
  }

  health(url) {
    const r = this.readiness();
    const ref = this.engine().modelRef();
    const turn = url.searchParams.get("turn") === "1" && r.ready ? this.turnProbe(url.searchParams.get("turn_message_id")?.trim() || null) : null;
    const harness = {
      id: "pi",
      version: CELL_VERSION,
      state: r.ready ? "ok" : r.error ? "error" : "starting",
      ready: r.ready,
      error: r.error,
      session: { id: this.rootId, required: true },
      turn: turn ? { in_flight: turn.inFlight, end: turn.end, orphaned_prompt: turn.orphanedPrompt } : null,
      details: { model: `${ref.providerID}/${ref.modelID}`, runtime: "pi-cell", instance: this.instance },
    };
    return json(200, {
      daemon: "ok",
      capabilities: CAPABILITIES,
      status: r.ready ? "ok" : harness.state,
      runtimeReady: r.ready,
      boot_error: r.error,
      workload: "session",
      uptime_s: Math.floor((Date.now() - this.bornAt) / 1000),
      static_web_port: null,
      repo_required: false,
      repo_ready: true,
      repo: this.effectiveEnv().KORTIX_REPO_URL ?? null,
      branch: this.effectiveEnv().KORTIX_BRANCH_NAME ?? null,
      commit_sha: null,
      agent_config_etag: this.effectiveEnv().KORTIX_COMPILED_AGENT_CONFIG_ETAG || null,
      // A runtime OBJECT, or apps/api classifies the box as legacy and tries
      // to replace its runtime (legacy-runtime-bootstrap.ts).
      runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false, running: {} },
      harness,
      ...(turn ? { turn_in_flight: turn.inFlight, turn_end: turn.end, turn_orphaned_prompt: turn.orphanedPrompt } : {}),
      // The pre-W3 flat names, for an API deploy that still reads them.
      opencode: harness.state,
      opencode_pid: null,
      opencode_port: null,
      opencode_session_id: this.rootId,
      opencode_session_required: true,
    });
  }

  /**
   * `POST /kortix/env`: the control plane's env push, bearer KORTIX_TOKEN
   * only. Project secrets and the runtime keys (model, gateway, compiled
   * agent) are stored with the session, so they survive an eviction.
   */
  async applyEnv(req) {
    if (req.headers.get("x-kortix-user-context")) return json(403, { error: "env push takes the session token, not a user context" });
    const token = String(this.effectiveEnv().KORTIX_TOKEN ?? "").trim();
    if (!token) return json(503, { error: "this cell has no KORTIX_TOKEN to verify the push with" });
    if ((req.headers.get("authorization") ?? "") !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
    const body = await req.json().catch(() => null);
    // kortixd's validation, exactly: an empty push must not read as "the
    // project now has no env" and delete every name the last one managed.
    if (!body || typeof body.revision !== "string") return json(400, { error: "revision is required" });
    if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)) return json(400, { error: "env object is required" });
    const env = body.env;
    const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === "string") : Object.keys(env);
    const before = JSON.stringify(this.sessionEnv);
    const write = (k, v) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return;
      if (v === null || v === undefined) {
        delete this.sessionEnv[k];
        this.sql.exec("DELETE FROM session_env WHERE k = ?", k);
      } else {
        this.sessionEnv[k] = String(v);
        this.sql.exec("INSERT INTO session_env(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
      }
    };
    // Names the previous push managed and this one dropped are removed.
    const prior = String(this.meta("project_env_names") ?? "").split(",").filter(Boolean);
    for (const n of prior) if (!names.includes(n) && !/^KORTIX_/.test(n)) write(n, null);
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") write(k, v);
    this.setMeta("project_env_names", names.join(","));
    const runtimeEnv = body.runtimeEnv ?? body.opencodeEnv;
    const runtimeNames = [];
    if (runtimeEnv && typeof runtimeEnv === "object") {
      for (const [k, v] of Object.entries(runtimeEnv)) {
        if (!/^KORTIX_/.test(k)) continue;
        write(k, v);
        runtimeNames.push(k);
      }
    }
    if (body.llmGatewayEnabled === true && typeof body.llmGatewayBaseUrl === "string" && body.llmGatewayBaseUrl.trim()) write("KORTIX_LLM_BASE_URL", body.llmGatewayBaseUrl.trim());
    if (body.llmGatewayEnabled === false) write("KORTIX_LLM_BASE_URL", null);
    if (typeof body.revision === "string") this.setMeta("env_revision", body.revision);
    const changed = before !== JSON.stringify(this.sessionEnv);
    if (changed) { this.__prompt = null; this.__agentRaw = null; }
    this.prewarmCheckout();
    const exported = Object.keys(env).filter((k) => typeof env[k] === "string").length;
    return json(200, {
      ok: true,
      changed,
      revision: body.revision ?? null,
      names,
      exported,
      managed: names.length,
      withheld: 0,
      agent_env_written: true,
      egress_shim: "skipped",
      egress_shim_hosts: [],
      runtime_env_changed: runtimeNames.length > 0,
      runtime_env_names: runtimeNames.sort(),
      runtime: this.readiness().ready ? "ok" : "starting",
      runtime_pid: null,
      runtime_reload: null,
      runtime_turn_ended: null,
      opencode_env_changed: runtimeNames.length > 0,
      opencode_env_names: runtimeNames,
      opencode: "ok",
      opencode_pid: null,
      opencode_reload: null,
      opencode_turn_ended: null,
    });
  }

  async runtimeRoute(req, sub, url, method) {
    const verb = (status, body) => json(status, body, { "x-kortix-turn-verb": "1" });
    const prompt = /^\/sessions\/([^/]+)\/prompt$/.exec(sub);
    if (prompt && method === "POST") {
      if (decodeSegment(prompt[1]) !== this.rootId) return verb(404, { error: "not the session root" });
      const r = this.readiness();
      if (!r.ready) return verb(503, { code: "runtime_not_ready", error: r.error ?? "the pi cell is starting", reason: r.phase, phase: r.phase });
      let input;
      try { input = parsePromptBody(await req.json(), { verb: true }); } catch (e) { return verb(400, { error: errorText(e) }); }
      try {
        const admitted = await this.admit(input);
        return admitted.deduplicated ? verb(200, { deduplicated: true }) : verb(202, { message_id: admitted.messageId });
      } catch (e) {
        return verb(503, { error: errorText(e) });
      }
    }
    const abort = /^\/sessions\/([^/]+)\/abort$/.exec(sub);
    if (abort && method === "POST") {
      if (decodeSegment(abort[1]) !== this.rootId) return verb(404, { error: "not the session root" });
      await this.engine().abort().catch(() => false);
      return verb(200, true);
    }
    const one = /^\/messages\/([^/]+)\/([^/]+)$/.exec(sub);
    if (one) {
      if (decodeSegment(one[1]) !== this.rootId) return verb(404, { error: "unknown session" });
      const message = this.transcript.messageById(decodeSegment(one[2]));
      if (!message) return verb(404, { error: "unknown message" });
      if (method === "DELETE") return verb(409, { error: "message deletion is not supported by the pi cell" });
      return verb(200, this.#strip(message));
    }
    const list = /^\/messages\/([^/]+)$/.exec(sub);
    if (list && method === "GET") {
      const sessionId = decodeSegment(list[1]);
      if (sessionId !== this.rootId) return json(200, { session_id: sessionId, epoch: this.bus.epoch, seq: this.bus.headSeq, head_seq: null, source: "pi", count: 0, has_more: false, first_message_id: null, last_message_id: null, dropped: 0, attachments_referenced: 0, attachment_bytes_saved: 0, tool_outputs_truncated: 0, messages: [] });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
      const after = url.searchParams.get("after")?.trim() || null;
      const before = url.searchParams.get("before")?.trim() || null;
      const page = after ? { messages: this.transcript.after(after, limit), hasMore: false } : this.transcript.page({ limit, before });
      const stripped = stripInlineAttachmentBytes(page.messages, (m, p) => `/kortix/part/${encodeURIComponent(sessionId)}/${encodeURIComponent(m)}/${encodeURIComponent(p)}`);
      const messages = stripped.value;
      return json(200, {
        session_id: sessionId, epoch: this.bus.epoch, seq: this.bus.headSeq, head_seq: null, source: "pi",
        count: messages.length, has_more: page.hasMore,
        first_message_id: messages[0]?.info.id ?? null, last_message_id: messages.at(-1)?.info.id ?? null,
        dropped: 0, attachments_referenced: stripped.stripped, attachment_bytes_saved: stripped.savedBytes, tool_outputs_truncated: 0,
        messages,
      }, { "x-kortix-transcript-source": "pi" });
    }
    if (sub === "/agents" && method === "GET") {
      const { config, name } = this.agentConfig();
      const agents = (config.names.length ? config.names : [name ?? this.agentName()]).map((n) => ({ name: n, description: config.agents[n]?.description ?? null, mode: config.agents[n]?.mode ?? null }));
      return verb(200, { agents });
    }
    if (sub === "/state" && method === "GET") {
      const doc = await this.stateDoc();
      const etag = await this.etag(doc);
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(200, doc, { etag });
    }
    if (sub === "/events" && method === "GET") {
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
      return runtimeEventStream(this.bus, { since, epoch: url.searchParams.get("epoch")?.trim() || null });
    }
    return notFound(`/kortix/runtime${sub}`);
  }

  async stateDoc() {
    const { config, name } = this.agentConfig();
    const ref = this.engine().modelRef();
    const agentName = name ?? this.agentName();
    const agents = (config.names.length ? config.names : [agentName]).map((n) => ({
      name: n,
      description: config.agents[n]?.description ?? null,
      mode: config.agents[n]?.mode ?? null,
      native: false,
      hidden: config.agents[n]?.hidden ?? null,
      color: config.agents[n]?.color ?? null,
      variant: config.agents[n]?.variant ?? null,
      source: "config",
      model: n === agentName ? { providerID: ref.providerID, modelID: ref.modelID } : null,
    }));
    const session = this.sessionObject();
    return {
      schema: "kortix.runtime.v1",
      epoch: this.bus.epoch,
      seq: this.bus.headSeq,
      built_at: new Date().toISOString(),
      identity: { harness: "pi", runtime_session_id: this.rootId, harness_version: CELL_VERSION, daemon_build: null, agent_config_etag: this.effectiveEnv().KORTIX_COMPILED_AGENT_CONFIG_ETAG || null, head_seq: null },
      agents: { known: true, value: agents },
      commands: { known: true, value: [] },
      config: { known: true, value: { model: `${ref.providerID}/${ref.modelID}`, small_model: null, default_agent: agentName, permission: null, instructions: null, enabled_providers: [ref.providerID] } },
      sessions: { known: true, value: [{ id: this.rootId, title: session.title, parent_id: null, directory: CELL_CWD, time: { created: session.time.created, updated: session.time.updated, compacting: session.time.compacting ?? null, archived: null }, revert: null }] },
      statuses: { known: true, value: { [this.rootId]: { type: this.engine().activeTurn() ? "busy" : "idle" } } },
      permissions: { known: true, value: [] },
      questions: { known: true, value: [] },
    };
  }

  async etag(doc) {
    const { built_at: _built, ...rest } = doc;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rest)));
    return `"sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}"`;
  }

  #strip(message) {
    const sid = this.rootId;
    return stripInlineAttachmentBytes(message, (m, p) => `/kortix/part/${encodeURIComponent(sid)}/${encodeURIComponent(m)}/${encodeURIComponent(p)}`).value;
  }

  partRoute(messageId, partId) {
    const message = this.transcript.messageById(messageId);
    const part = message?.parts.find((p) => p.id === partId);
    if (!part || part.type !== "file") return json(404, { error: "attachment not found" });
    const decoded = decodeDataUrl(part.url);
    if (!decoded) return json(404, { error: "attachment bytes are not held by this cell" });
    return new Response(decoded.bytes, { status: 200, headers: { "content-type": part.mime || decoded.mime } });
  }

  async sessionRoute(req, sessionId, sub, url, method) {
    if (sessionId === null) return json(400, { error: "path contains malformed percent-encoding" });
    if (sessionId !== this.rootId) return json(404, { error: "unknown session" });
    if (sub === "" && method === "GET") return json(200, this.sessionObject());
    if (sub === "" && method === "PATCH") return json(200, this.sessionObject());
    if (sub === "" && method === "DELETE") return json(200, true);
    if (sub === "children" && method === "GET") return json(200, []);
    const message = /^message(?:\/([^/]+)(?:\/part\/([^/]+))?)?$/.exec(sub);
    if (message && method === "GET") {
      const messageId = message[1] ? decodeSegment(message[1]) : null;
      if (!messageId) {
        const limitRaw = Number(url.searchParams.get("limit") ?? 0);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : Math.max(this.transcript.count, 1);
        const before = (url.searchParams.get("before") ?? url.searchParams.get("cursor"))?.trim() || null;
        const page = this.transcript.page({ limit, before });
        const older = page.hasMore ? String(page.messages[0]?.info.id ?? "") : "";
        return json(200, page.messages.map((m) => this.#strip(m)), older ? { "x-next-cursor": older } : {});
      }
      const found = this.transcript.messageById(messageId);
      if (!found) return json(404, { error: "unknown message" });
      return json(200, this.#strip(found));
    }
    if (message && method === "DELETE") return json(409, { error: "message deletion is not supported by the pi cell" });
    if (message && method === "PATCH") return json(501, { code: "feature_not_supported", error: "part edits are not supported by the pi cell" });
    if ((sub === "prompt_async" || sub === "message") && method === "POST") {
      const r = this.readiness();
      if (!r.ready) return json(503, { code: "runtime_not_ready", error: r.error ?? "the pi cell is starting", phase: r.phase });
      let input;
      try { input = parsePromptBody(await req.json()); } catch (e) { return json(400, { error: errorText(e) }); }
      let admitted;
      try { admitted = await this.admit(input); } catch (e) { return json(503, { error: errorText(e) }); }
      if (admitted.deduplicated) return json(200, { deduplicated: true });
      if (sub === "prompt_async") return new Response(null, { status: 204 });
      await this.engine().waitForIdle(10 * 60_000);
      const reply = this.transcript.all().filter((m) => m.info.role === "assistant" && m.info.parentID === admitted.messageId).at(-1);
      return json(200, reply ? this.#strip(reply) : { info: { id: admitted.messageId, role: "user", sessionID: this.rootId }, parts: [] });
    }
    if (sub === "command" && method === "POST") return json(400, { error: "the pi cell has no slash commands" });
    if (sub === "abort" && method === "POST") {
      await this.engine().abort().catch(() => false);
      return json(200, true);
    }
    if (sub === "todo" && method === "GET") return json(200, readTodos(this.sql));
    if (sub === "diff" && method === "GET") {
      const menv = await this.machineEnv();
      if (menv) { await this.machineRepoReady(); return json(200, await machineGit(menv).fileDiffs().catch(() => [])); }
      await this.ensureCheckout().catch(() => null);
      return json(200, await fileDiffs(this.cell()).catch(() => []));
    }
    if (sub === "summarize" && method === "POST") {
      try { await this.engine().compact(); await this.state.storage.setAlarm(Date.now() + 1); } catch (e) { return json(503, { error: errorText(e) }); }
      return json(200, true);
    }
    if (["revert", "unrevert", "init", "fork", "share", "shell"].includes(sub) && method === "POST") {
      return json(501, { code: "feature_not_supported", error: `${sub} is not supported by the pi cell` });
    }
    return notFound(`/session/${sessionId}/${sub}`);
  }

  async fileRoute(req, path, url, method) {
    await this.ensureCheckout().catch(() => null);
    const tree = await this.workspaceFs();
    if (path === "/file/status" && method === "GET") {
      if (tree.kind === "machine") return json(200, await machineGit(await this.machineEnv()).status().catch(() => []));
      return json(200, await workingStatus(this.cell()).catch(() => []));
    }
    const answered = await filesAnswer(req, path, url, tree);
    return answered ?? notFound(path);
  }

  async commitPush(req) {
    const body = await req.json().catch(() => ({}));
    const e = this.effectiveEnv();
    if (this.__commitPush) return json(409, { error: "commit-push already running" });
    const menv = await this.machineEnv();
    if (menv) await this.machineRepoReady();
    const message = typeof body?.message === "string" ? body.message : undefined;
    this.__commitPush = (menv
      ? machineGit(menv).commitAndPush({ branch: e.KORTIX_BRANCH_NAME, message })
      : commitAndPush({ cell: this.cell(), url: e.KORTIX_REPO_URL, token: e.KORTIX_TOKEN, branch: e.KORTIX_BRANCH_NAME, message })
    ).finally(() => { this.__commitPush = null; });
    const r = await this.__commitPush;
    return r.ok
      ? json(200, { ok: true, committed: r.committed, pushed: r.pushed, nothingToDo: r.nothingToDo, branch: r.branch, headSha: r.headSha })
      : json(r.status ?? 500, { error: "commit-push failed", message: r.error });
  }

  // ── the terminal ───────────────────────────────────────────────────────

  async ptyRoute(req, path, method) {
    if (req.headers.get("upgrade") === "websocket") return this.ptySocket(req, path);
    const one = /\/kortix\/pty\/([^/]+)$/.exec(path);
    if (path === "/kortix/pty" && method === "GET") return json(200, ptyList(this.sql));
    if (path === "/kortix/pty" && method === "POST") return json(200, ptyCreate(this.sql, (await req.json().catch(() => ({}))) ?? {}));
    if (one && method === "PATCH") {
      const updated = ptyUpdate(this.sql, decodeSegment(one[1]), (await req.json().catch(() => ({}))) ?? {});
      return updated ? json(200, updated) : json(404, { error: "pty not found" });
    }
    if (one && method === "DELETE") {
      const id = decodeSegment(one[1]);
      const gone = ptyRemove(this.sql, id);
      for (const [ws, t] of this.terminals ?? []) {
        if (t.ptyId === id) { try { ws.close(1000, "pty exited"); } catch { /* gone */ } this.terminals.delete(ws); }
      }
      return gone ? json(200, true) : json(404, { error: "pty not found" });
    }
    return notFound(path);
  }

  ptySocket(req, path) {
    const m = /\/kortix\/pty\/([^/]+?)(?:\/connect)?$/.exec(path);
    const pair = new WebSocketPair();
    if (!m) {
      pair[1].accept?.();
      try { pair[1].close(1008, "only terminal sockets are served"); } catch { /* gone */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const ptyId = decodeSegment(m[1]);
    const record = ptyGet(this.sql, ptyId);
    if (typeof this.state.acceptWebSocket === "function") this.state.acceptWebSocket(pair[1], [`pty:${ptyId}`]);
    else pair[1].accept?.();
    if (!record) {
      try { pair[1].close(1000, "pty not found"); } catch { /* gone */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    this.terminals ??= new Map();
    this.terminals.set(pair[1], { ptyId, editor: newEditor(record.cwd), abort: null });
    try { pair[1].send(banner(record.cwd)); } catch { /* gone */ }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  adoptTerminal(ws) {
    const tag = (this.state.getTags?.(ws) ?? []).find((t) => typeof t === "string" && t.startsWith("pty:"));
    if (!tag) return null;
    const ptyId = tag.slice("pty:".length);
    const record = ptyGet(this.sql, ptyId);
    if (!record) return null;
    const term = { ptyId, editor: newEditor(record.cwd), abort: null };
    this.terminals ??= new Map();
    this.terminals.set(ws, term);
    return term;
  }

  async webSocketMessage(ws, message) {
    this.init();
    const term = this.terminals?.get(ws) ?? this.adoptTerminal(ws);
    if (term) return this.terminalInput(ws, term, message);
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already gone */ }
    this.terminals?.delete(ws);
  }

  /** One line of a terminal: echo it, and when complete run it in the session's shell. */
  async terminalInput(ws, term, message) {
    const r = feed(term.editor, message);
    term.editor = r.state;
    if (r.echo) { try { ws.send(r.echo); } catch { /* gone */ } }
    if (r.interrupt) { try { term.abort?.abort(); } catch { /* done */ } }
    if (r.close) { try { ws.close(1000, "pty exited"); } catch { /* gone */ } this.terminals?.delete(ws); return; }
    if (r.line === null) return;
    const line = r.line.trim();
    if (!line) { try { ws.send(prompt(term.editor.cwd)); } catch { /* gone */ } return; }
    if (line === "exit" || line === "logout") {
      try { ws.send("exit\r\n"); ws.close(1000, "pty exited"); } catch { /* gone */ }
      this.terminals?.delete(ws);
      return;
    }
    const env = await this.toolEnv(term.editor.cwd);
    const cd = cdTarget(line);
    const command = cd === null ? line : `cd ${cd === "~" ? CELL_CWD : cd} && pwd`;
    const ctl = new AbortController();
    term.abort = ctl;
    const out = await runCapture(env, command, { cwd: term.editor.cwd, timeout: 120, abortSignal: ctl.signal }).catch((e) => ({ ok: false, error: { message: errorText(e) }, stdout: "", stderr: "" }));
    term.abort = null;
    const crlf = (t) => String(t ?? "").replace(/\r?\n/g, "\r\n");
    if (!out.ok) {
      try { ws.send(crlf(`${out.error?.message ?? "command failed"}\n`)); } catch { /* gone */ }
    } else if (cd !== null && out.exitCode === 0) {
      term.editor.cwd = out.stdout.trim() || term.editor.cwd;
      ptySetCwd(this.sql, term.ptyId, term.editor.cwd);
    } else {
      const body = `${out.stdout}${out.stderr}`;
      if (body) { try { ws.send(crlf(body.endsWith("\n") ? body : `${body}\n`)); } catch { /* gone */ } }
    }
    try { ws.send(prompt(term.editor.cwd)); } catch { /* gone */ }
  }
}

// ── the router ───────────────────────────────────────────────────────────

/** A path that names its session's root. */
const ROOT_IN_PATH = /^\/(?:session|kortix\/(?:runtime|opencode)\/(?:sessions|messages)|kortix\/part)\/(ses_pi[0-9a-f]{24})(?:\/|$)/;

/** The roots this node has served: a resumed box that lost its env still knows its one session. */
const knownRoots = new Set();

let cachedRoot = null;
async function rootOfSession(sessionId) {
  if (!sessionId) return null;
  if (cachedRoot?.session !== sessionId) cachedRoot = { session: sessionId, root: await mintRootId(sessionId) };
  return cachedRoot.root;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, runtime: "pi-cell", version: CELL_VERSION });
    const c = url.searchParams.get("c");
    const fromPath = ROOT_IN_PATH.exec(url.pathname)?.[1] ?? null;
    const root = fromPath
      ?? (c ? (ROOT_ID.test(c) ? c : await rootOfSession(c)) : null)
      ?? (await rootOfSession(env.KORTIX_SESSION_ID))
      ?? (knownRoots.size === 1 ? [...knownRoots][0] : null);
    if (!root) {
      // FINAL, NOT COLD: the API's sandbox proxy retries a 503 as a port still
      // coming up; this one names no session and never will. `x-kortix-final`
      // stops the retries.
      return Response.json(
        { code: "runtime_not_ready", error: "this cell has no session", detail: "the box carries no KORTIX_SESSION_ID and the request names no root" },
        { status: 503, headers: { "retry-after": "5", "x-kortix-final": "1", "x-kortix-boot-phase": "cell|no-session" } },
      );
    }
    if (knownRoots.size < 64) knownRoots.add(root);
    const headers = new Headers(req.headers);
    headers.set("x-kortix-cell-root", root);
    return env.AGENT.get(env.AGENT.idFromName(root)).fetch(new Request(req, { headers }));
  },
};
