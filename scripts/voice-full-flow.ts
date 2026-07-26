#!/usr/bin/env bun
/**
 * FULL-FLOW harness for the voice product path — provision a user, flip on the
 * connector, boot a sandbox, drive the voice MCP the way an in-sandbox agent
 * does, join the live call and actually speak into it, and assert on durable
 * signals (DB rows, HTTP statuses, audio frames) at every hop. One PASS/FAIL/
 * WARN/SKIP line per step; non-zero exit on any FAIL.
 *
 * Usage (fresh run, does everything — KORTIX_URL is required by apps/api's
 * own config validation, same as running the API itself):
 *   KORTIX_URL=http://localhost:15608 \
 *     dotenvx run -f apps/api/.env --quiet -- bun scripts/voice-full-flow.ts
 *
 * Usage (iterate against an already-provisioned call):
 *   KORTIX_URL=http://localhost:15608 \
 *     dotenvx run -f apps/api/.env --quiet -- bun scripts/voice-full-flow.ts \
 *     --skip-provision --call <sessionId> [--skip-connector --skip-session]
 *
 * Run `bun scripts/voice-full-flow.ts --help` for the full flag list.
 *
 * ── Two things this file does that are NOT obvious from the task list ──────
 *
 * 1. MODULE RESOLUTION. This file lives in the repo-root `scripts/` workspace,
 *    which has neither `livekit-server-sdk` (an apps/api dependency) nor
 *    `@livekit/rtc-node` (an apps/voice-agent dependency) reachable via a plain
 *    `import` — Node/Bun resolve bare specifiers relative to the IMPORTING
 *    FILE's own node_modules chain, and this file's chain is the root
 *    workspace's. (`apps/api/src/**` imports resolve fine here because *they*
 *    are the importing file once loaded — same reason scripts/voice-live-test.ts
 *    can `import { startCall } from '../apps/api/src/channels/voice/runtime'`.)
 *    `loadFrom()` below works around this with `Bun.resolveSync` rooted at the
 *    owning workspace, then a dynamic `import()` of the resolved path. No
 *    existing file needed editing (no new root dependency) to make this work.
 *
 * 2. THE SIMULATED SPAWN'S BLAST RADIUS. `voice_spawn` always dispatches a
 *    real Recall bot at a real meeting_url (routes.ts's ctx.spawn -> the
 *    executor gateway -> Recall's /bot/) — there is no dry-run mode. Step 4
 *    below therefore does NOT call the MCP tool; it imports `startCall`
 *    straight from apps/api/src/channels/voice/runtime and calls it in
 *    *this script's own process*. That's a real LiveKit room with a real
 *    dispatched worker — good enough for steps 6-7 (speak + transcript, which
 *    read straight from Postgres). But runtime.ts's call registry is
 *    deliberately per-process ("a call is pinned to whichever API instance
 *    handled its voice_spawn"), so the REAL running API server (the one
 *    apps/voice-agent's worker calls back into over HTTP) never learns this
 *    call exists. Concretely:
 *      - POST .../voice/turns does NOT require a registry entry (routes.ts
 *        says so explicitly) -> works fine, step 7 is a clean signal.
 *      - POST .../voice/prompt and .../voice/run-command DO require one ->
 *        they will 404 against the live API server even when the worker
 *        correctly attempts them. Step 8 therefore asserts on the API's
 *        access log (a POST reaching the route at all), never on the HTTP
 *        status, and step 10 closes the room via the same direct-import path
 *        it was opened with rather than through the (here, inevitably
 *        "not live") MCP voice_end call.
 *    None of this is a bug in the product; it's this harness trading one
 *    known, documented gap for the ability to run at all without spending
 *    Recall bot-minutes on a real meeting. Every place it matters says so
 *    inline when it prints its result.
 */

// ── apps/api internals, imported straight from source ──────────────────────
// These resolve fine (see file header point 1): each of these files' OWN
// imports (drizzle-orm, @kortix/db, livekit-server-sdk, ...) are resolved
// relative to THAT file's location inside apps/api, not this one.
import { db } from '../apps/api/src/shared/db';
import { config } from '../apps/api/src/config';
import { startCall, endCall, readTurns } from '../apps/api/src/channels/voice/runtime';
import { roomNameForCall, mintAccessToken } from '../apps/api/src/channels/voice/livekit';
import { resolveProjectBotName } from '../apps/api/src/channels/voice-identity';
import { runCommandInSandbox } from '../apps/api/src/channels/voice/run-command';

// ── workspace-scoped packages this file cannot `import` directly (see header
// point 1) — includes drizzle-orm/@kortix/db, which are apps/api dependencies
// too, not root ones, even though the schema TYPES flow through fine above
// via `db`'s own inferred type. ──────────────────────────────────────────
const ROOT_DIR = new URL('../', import.meta.url).pathname;
const API_DIR = `${ROOT_DIR}apps/api/`;
const VOICE_AGENT_DIR = `${ROOT_DIR}apps/voice-agent/`;

async function loadFrom(spec: string, fromDir: string): Promise<any> {
  const resolved = Bun.resolveSync(spec, fromDir);
  return import(resolved);
}

const { RoomServiceClient } = await loadFrom('livekit-server-sdk', API_DIR);
const {
  Room,
  RoomEvent,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  AudioStream,
  TrackPublishOptions,
  TrackSource,
} = await loadFrom('@livekit/rtc-node', VOICE_AGENT_DIR);
const { and, eq } = await loadFrom('drizzle-orm', API_DIR);
const { executorConnectors, projectSessions } = await loadFrom('@kortix/db', API_DIR);

// ── constants ────────────────────────────────────────────────────────────
const API = process.env.KE2E_API_URL || 'http://localhost:15608/v1';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const DEFAULT_API_LOG =
  '/tmp/claude-501/-Users-markokraemer-Projects-kortix-suna/aa206d1b-1ea8-4354-ad2d-e5e148a8e827/scratchpad/api3.log';
const EXPECTED_TOOLS = ['voice_spawn', 'voice_read', 'send_prompt', 'run_command', 'voice_end'];

// ── tiny arg parser ─────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function j(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function printHelp() {
  console.log(`voice-full-flow.ts — end-to-end proof of the voice product path

  --skip-provision          reuse an existing project/session instead of minting one
  --project <id>            project id (required with --skip-provision unless derivable from --call)
  --call <id>                session id == call id (required with --skip-provision)
  --token <executorToken>   skip fetching KORTIX_EXECUTOR_TOKEN from the sandbox
  --say "<text>"            phrase spoken in step 6 (default: a plain "can you hear me")
  --run-command-say "<text>" phrase spoken in step 8 to trigger run_command
  --api-log <path>          API access-log path checked in step 8 (default: ${DEFAULT_API_LOG})

  --skip-connector          skip the experimental-flag + connector-materialize check
  --skip-session            skip session creation (only meaningful with --skip-provision)
  --skip-spawn              skip opening the LiveKit room (runtime.startCall)
  --skip-mcp-list           skip the tools/list MCP assertion
  --skip-speak              skip joining + speaking into the room
  --skip-transcript         skip the voice_call_turns user+agent row assertion
  --skip-run-command        skip the run_command trigger-phrase + API-log check
  --skip-voice-read         skip the voice_read MCP assertion
  --skip-end                skip voice_end + room-closed assertion

  --help                    print this and exit
`);
}

// ── result tracking ─────────────────────────────────────────────────────
type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
interface StepRecord {
  name: string;
  status: Status;
  detail?: string;
}
const results: StepRecord[] = [];

function record(name: string, status: Status, detail?: string): void {
  results.push({ name, status, detail });
  console.log(`[${status.padEnd(4)}] ${name}${detail ? ' — ' + detail : ''}`);
}

function summarizeAndExit(): never {
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`  [${r.status.padEnd(4)}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  console.log(
    `\n${results.length - failed.length}/${results.length} not-FAIL ` +
      `(${failed.length} FAIL, ${warned.length} WARN)`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

function abort(name: string, err: unknown): never {
  record(name, 'FAIL', err instanceof Error ? err.message : String(err));
  console.error(`\nFATAL — cannot continue past "${name}". Aborting remaining steps.`);
  summarizeAndExit();
}

// ── step 1 + 3 helpers: provision a real user/project/session ──────────────
async function provisionUser(): Promise<{ projectId: string; userJwt: string }> {
  const stamp = Date.now();
  const email = `voice-full-flow-${stamp}@example.test`;
  const password = `Voice-${stamp}!aA`;

  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`user create failed: ${created.status} ${await created.text()}`);

  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const auth = await j(signIn);
  const userJwt = auth?.access_token;
  if (!userJwt) throw new Error(`sign-in failed: ${JSON.stringify(auth).slice(0, 300)}`);

  const H = { Authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' };
  // /provision (not the plain create): mints a managed repo, same path the
  // e2e fixtures use — see scripts/voice-e2e-session.ts, which this mirrors.
  const projRes = await fetch(`${API}/projects/provision`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: `voice-full-flow-${stamp}`, seed_starter: true }),
  });
  const proj = await j(projRes);
  const projectId = proj?.project_id ?? proj?.project?.project_id ?? proj?.id;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(proj).slice(0, 400)}`);

  return { projectId, userJwt };
}

async function createSessionAndWaitReady(projectId: string, userJwt: string): Promise<string> {
  const H = { Authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' };
  const sessRes = await fetch(`${API}/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ initial_prompt: 'Say hello and wait for instructions.' }),
  });
  const sess = await j(sessRes);
  const sessionId = sess?.session?.session_id ?? sess?.session_id ?? sess?.id;
  if (!sessionId) throw new Error(`session create failed: ${JSON.stringify(sess).slice(0, 500)}`);

  for (let i = 0; i < 80; i++) {
    const s = await j(await fetch(`${API}/projects/${projectId}/sessions/${sessionId}`, { headers: H }));
    const stage = s?.session?.sandbox?.stage ?? s?.sandbox?.stage ?? s?.session?.status ?? s?.status;
    if (i % 5 === 0) console.log(`  …sandbox ${stage}`);
    if (stage === 'ready' || stage === 'running') return sessionId;
    if (stage === 'failed') throw new Error('sandbox failed to boot');
    await sleep(3000);
  }
  throw new Error('sandbox did not become ready within 240s');
}

// ── voice MCP over HTTP, exactly as an in-sandbox agent would call it ──────
async function mcpCall(
  projectId: string,
  sessionId: string,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}/projects/${projectId}/mcp/voice`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Defensive only — a project-scoped session token already carries this
      // session id server-side; see db-deps.ts's resolveProjectPrincipal.
      'X-Kortix-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const body = await j(res);
  return { status: res.status, body };
}

// ── LiveKit probe: join the room, publish a mic track, count agent frames ──
interface ProbeState {
  agentJoined: boolean;
  frameCount: number;
}
interface Probe {
  room: any;
  source: any;
  state: ProbeState;
}

async function connectProbe(url: string, token: string): Promise<Probe> {
  const room = new Room();
  const state: ProbeState = { agentJoined: false, frameCount: 0 };

  room.on(RoomEvent.ParticipantConnected, (p: any) => {
    if (!String(p.identity).startsWith('probe-')) state.agentJoined = true;
  });
  room.on(RoomEvent.TrackSubscribed, (track: any) => {
    const stream = new AudioStream(track);
    (async () => {
      for await (const _frame of stream) state.frameCount++;
    })().catch(() => {});
  });

  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  // Give the worker a moment to be dispatched; ParticipantConnected only
  // fires for joins AFTER us, so also sweep whoever is already there.
  await sleep(4000);
  for (const [, p] of room.remoteParticipants ?? new Map()) {
    if (!String(p.identity).startsWith('probe-')) state.agentJoined = true;
  }

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('probe-mic', source);
  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, opts);

  return { room, source, state };
}

async function speechPcm(text: string): Promise<Int16Array> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'onyx',
      input: text,
      response_format: 'pcm', // raw 24kHz s16le mono
    }),
  });
  if (!res.ok) throw new Error(`tts failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

async function speak(source: any, text: string): Promise<void> {
  const pcm = await speechPcm(text);
  // 10ms frames at wall-clock pace so turn detection sees natural timing.
  const per = (SAMPLE_RATE / 100) * CHANNELS;
  for (let off = 0; off < pcm.length; off += per) {
    const chunk = pcm.subarray(off, Math.min(off + per, pcm.length));
    await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length / CHANNELS));
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return cond();
}

// ── step 8: did a POST for run-command reach the API's access log? ────────
async function fileSize(path: string): Promise<number | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  return f.size;
}
async function fileDelta(path: string, sinceOffset: number): Promise<string> {
  const f = Bun.file(path);
  const size = f.size;
  if (size <= sinceOffset) return '';
  return f.slice(sinceOffset, size).text();
}

async function main() {
  if (flag('help')) {
    printHelp();
    process.exit(0);
  }

  console.log('=== voice-full-flow ===\n');

  const skipProvision = flag('skip-provision');
  let projectId = arg('project');
  let sessionId = arg('call');
  let userJwt: string | undefined;

  // ── step 1: provision a NEW user + project ────────────────────────────
  if (!skipProvision) {
    try {
      const p = await provisionUser();
      projectId = p.projectId;
      userJwt = p.userJwt;
      record('1-provision', 'PASS', `project=${projectId}`);
    } catch (err) {
      abort('1-provision', err);
    }
  } else {
    if (!sessionId) {
      console.error('--skip-provision requires --call <sessionId>');
      process.exit(1);
    }
    if (!projectId) {
      const [row] = await db
        .select({ projectId: projectSessions.projectId })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      if (!row) abort('1-provision', new Error(`session ${sessionId} not found in DB — pass --project explicitly`));
      projectId = row!.projectId;
    }
    record('1-provision', 'SKIP', `reusing project=${projectId} call=${sessionId}`);
  }

  // ── step 2: enable the voice experimental flag + assert the connector ──
  if (flag('skip-connector')) {
    record('2-connector', 'SKIP');
  } else {
    try {
      if (userJwt) {
        const res = await fetch(`${API}/projects/${projectId}/experimental`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({ feature: 'voice', enabled: true }),
        });
        if (!res.ok) console.log(`  [warn] PATCH /experimental → ${res.status} ${(await res.text()).slice(0, 200)}`);
      } else {
        console.log('  [info] no fresh user token (reusing a project) — checking materialization only');
      }
      // reconcileChannelConnectors runs fire-and-forget off the PATCH; poll.
      let foundEnabled = false;
      for (let i = 0; i < 12; i++) {
        const rows = await db
          .select({ enabled: executorConnectors.enabled })
          .from(executorConnectors)
          .where(and(eq(executorConnectors.projectId, projectId!), eq(executorConnectors.slug, 'kortix_voice')))
          .limit(1);
        if (rows.length && rows[0]!.enabled) {
          foundEnabled = true;
          break;
        }
        await sleep(1500);
      }
      record(
        '2-connector',
        foundEnabled ? 'PASS' : 'FAIL',
        foundEnabled
          ? 'kortix_voice connector row present + enabled'
          : 'kortix_voice connector row not found — check the voice experimental flag and RECALL_API_KEY',
      );
    } catch (err) {
      record('2-connector', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 3: create a session and wait for its sandbox ──────────────────
  if (!skipProvision) {
    try {
      sessionId = await createSessionAndWaitReady(projectId!, userJwt!);
      record('3-session', 'PASS', `session=${sessionId}`);
    } catch (err) {
      abort('3-session', err);
    }
  } else if (flag('skip-session')) {
    record('3-session', 'SKIP');
  } else {
    record('3-session', 'SKIP', `reusing session=${sessionId} (assumed ready)`);
  }

  // ── prerequisite: the per-session executor token the sandbox's agent
  // would carry (KORTIX_EXECUTOR_TOKEN), needed for every real MCP call
  // below. Fetched by executing `printenv` INSIDE the sandbox — the same
  // primitive the voice run_command tool itself uses — rather than minting
  // a new one, so this is the actual credential a live agent has, not a
  // stand-in. Not fatal: MCP-dependent steps just SKIP without it.
  let executorToken = arg('token');
  if (executorToken) {
    record('token', 'SKIP', 'using --token override');
  } else {
    try {
      const result = await runCommandInSandbox(sessionId!, 'printenv KORTIX_EXECUTOR_TOKEN');
      const tok = result.stdout.trim().split('\n').pop()?.trim();
      if (!tok || result.timedOut) {
        throw new Error(`printenv returned nothing (timedOut=${result.timedOut}, exit=${result.exitCode})`);
      }
      executorToken = tok;
      record('token', 'PASS', `fetched KORTIX_EXECUTOR_TOKEN (${tok.slice(0, 12)}…)`);
    } catch (err) {
      record('token', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 4: "spawn" — open the LiveKit room WITHOUT dispatching Recall ──
  let roomOpened = false;
  if (flag('skip-spawn')) {
    record('4-spawn', 'SKIP');
  } else {
    console.log(
      '  [info] voice_spawn was NOT called over MCP — it always dispatches a real Recall\n' +
        '         bot into a real meeting_url, with no dry-run mode (routes.ts ctx.spawn ->\n' +
        '         executor gateway -> Recall /bot/). This step instead imports runtime.startCall\n' +
        '         directly and calls it in-process, which opens a real LiveKit room and gets a\n' +
        '         real worker dispatched into it, simulating what voice_spawn would have done\n' +
        '         minus the Recall leg. See this file\'s header for the cross-process caveat\n' +
        '         this creates for steps 8 and 10.',
    );
    try {
      const botName = await resolveProjectBotName(projectId!).catch(() => 'Kortix');
      const call = await startCall({
        callId: sessionId!,
        projectId: projectId!,
        sessionId: sessionId!,
        botId: null,
        botName,
        voice: null,
      });
      roomOpened = true;
      record('4-spawn', 'PASS', `room=${call.room}`);
    } catch (err) {
      abort('4-spawn', err);
    }
  }

  // ── step 5: tools/list — exact tool surface, no blocking tool ──────────
  if (flag('skip-mcp-list')) {
    record('5-mcp-tools-list', 'SKIP');
  } else if (!executorToken) {
    record('5-mcp-tools-list', 'SKIP', 'no session token available');
  } else {
    try {
      const { status, body } = await mcpCall(projectId!, sessionId!, executorToken, 'tools/list', undefined, 5);
      if (status !== 200) {
        record('5-mcp-tools-list', 'FAIL', `HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
      } else {
        const names: string[] = (body?.result?.tools ?? []).map((t: { name: string }) => t.name);
        const sameSet = names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n));
        const hasBlocking = names.some((n) => /follow|tail|stream|wait/i.test(n));
        record(
          '5-mcp-tools-list',
          sameSet && !hasBlocking ? 'PASS' : 'FAIL',
          `got [${names.join(', ')}]${hasBlocking ? ' — BLOCKING TOOL PRESENT' : ''}`,
        );
      }
    } catch (err) {
      record('5-mcp-tools-list', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 6: join the room and SPEAK; assert the agent replies w/ audio ─
  let probe: Probe | null = null;
  if (flag('skip-speak')) {
    record('6-speak', 'SKIP');
  } else if (!roomOpened && !flag('skip-spawn')) {
    record('6-speak', 'FAIL', 'room was not opened (step 4 failed)');
  } else {
    try {
      const roomName = roomNameForCall(sessionId!);
      const token = await mintAccessToken({ room: roomName, identity: `probe-${Date.now()}`, name: 'full-flow probe' });
      probe = await connectProbe(config.LIVEKIT_URL, token);
      await sleep(1500); // let the published track settle
      const before = probe.state.frameCount;
      const sayText = arg('say') ?? 'Hello. Can you hear me? Please answer with a short sentence.';
      console.log(`  speaking: "${sayText}"`);
      await speak(probe.source, sayText);
      console.log('  waiting up to 20s for the agent to reply with audio…');
      await waitUntil(() => probe!.state.frameCount > before, 20_000, 500);
      const gotAudio = probe.state.frameCount > before;
      record(
        '6-speak',
        probe.state.agentJoined && gotAudio ? 'PASS' : 'FAIL',
        `agentJoined=${probe.state.agentJoined} framesBefore=${before} framesAfter=${probe.state.frameCount}`,
      );
    } catch (err) {
      record('6-speak', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 7: voice_call_turns has BOTH a user row and an agent row ─────
  if (flag('skip-transcript')) {
    record('7-transcript', 'SKIP');
  } else {
    try {
      const page = await readTurns(sessionId!, 0, 500);
      const hasUser = page.turns.some((t) => t.role === 'user');
      const hasAgent = page.turns.some((t) => t.role === 'agent');
      record(
        '7-transcript',
        hasUser && hasAgent ? 'PASS' : 'FAIL',
        `rows=${page.turns.length} user=${hasUser} agent=${hasAgent}` +
          (!hasUser ? ' — see BUG A (no user-role rows)' : ''),
      );
    } catch (err) {
      record('7-transcript', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 8: trigger run_command by speech; assert the POST reached the API ─
  if (flag('skip-run-command')) {
    record('8-run-command', 'SKIP');
  } else if (!probe) {
    record('8-run-command', 'SKIP', 'no live probe (step 6 skipped/failed)');
  } else {
    try {
      const logPath = arg('api-log') ?? DEFAULT_API_LOG;
      const offsetBefore = await fileSize(logPath);
      const cmdSay =
        arg('run-command-say') ?? 'Please run git status in the sandbox and tell me what branch we are on.';
      console.log(`  speaking: "${cmdSay}"`);
      await speak(probe.source, cmdSay);
      console.log('  waiting 15s for the worker to call run_command…');
      await sleep(15_000);

      if (offsetBefore === null) {
        record(
          '8-run-command',
          'WARN',
          `cannot read API log at ${logPath} (pass --api-log <path>). NOTE per this file's header: ` +
            'because step 4 opened the room via a direct runtime.startCall() import in THIS process, ' +
            'the real API server never registered this call, so even a correctly-firing worker POST to ' +
            '.../voice/run-command will 404 there — log evidence of the POST reaching the route is the ' +
            'only reliable signal here, not the HTTP status.',
        );
      } else {
        const delta = await fileDelta(logPath, offsetBefore);
        const hit = /voice\/run-command/i.test(delta);
        record(
          '8-run-command',
          hit ? 'PASS' : 'FAIL',
          hit
            ? `POST .../voice/run-command found in ${logPath}`
            : `no POST .../voice/run-command appended to ${logPath} in the last 15s — see BUG C`,
        );
      }
    } catch (err) {
      record('8-run-command', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 9: voice_read over MCP — turns + a monotonic cursor ───────────
  if (flag('skip-voice-read')) {
    record('9-voice-read', 'SKIP');
  } else if (!executorToken) {
    record('9-voice-read', 'SKIP', 'no session token available');
  } else {
    try {
      const { status, body } = await mcpCall(
        projectId!,
        sessionId!,
        executorToken,
        'tools/call',
        { name: 'voice_read', arguments: { call_id: sessionId, cursor: 0 } },
        9,
      );
      if (status !== 200) {
        record('9-voice-read', 'FAIL', `HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
      } else {
        const result = body?.result;
        const structured = result?.structuredContent;
        const turns: Array<{ cursor: number }> = structured?.turns ?? [];
        const cursor = structured?.cursor;
        const monotonic = turns.every((t, i) => i === 0 || t.cursor > turns[i - 1]!.cursor);
        const lastCursor = turns.length ? turns[turns.length - 1]!.cursor : 0;
        const ok =
          !result?.isError &&
          Array.isArray(turns) &&
          turns.length > 0 &&
          typeof cursor === 'number' &&
          cursor >= lastCursor &&
          monotonic;
        record('9-voice-read', ok ? 'PASS' : 'FAIL', `turns=${turns.length} cursor=${cursor} monotonic=${monotonic}`);
      }
    } catch (err) {
      record('9-voice-read', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── step 10: voice_end — assert the room actually closes ──────────────
  if (flag('skip-end')) {
    record('10-end', 'SKIP');
  } else {
    try {
      if (executorToken) {
        // Informational only — expected to report "not live" for the same
        // cross-process reason documented at the top of this file. The
        // authoritative close below uses the same process that opened the
        // room in step 4.
        const { status, body } = await mcpCall(
          projectId!,
          sessionId!,
          executorToken,
          'tools/call',
          { name: 'voice_end', arguments: { call_id: sessionId } },
          10,
        );
        console.log(`  [info] MCP voice_end → HTTP ${status} ${JSON.stringify(body).slice(0, 150)}`);
      }

      const roomName = roomNameForCall(sessionId!);
      const svc = new RoomServiceClient(
        config.LIVEKIT_URL.replace(/^ws/i, 'http'),
        config.LIVEKIT_API_KEY,
        config.LIVEKIT_API_SECRET,
      );
      const before = await svc.listRooms([roomName]).catch(() => []);
      const closed = await endCall(sessionId!);
      await sleep(1500);
      const after = await svc.listRooms([roomName]).catch(() => []);

      if (before.length === 0) {
        record('10-end', 'WARN', 'room did not exist before voice_end — was step 4 skipped?');
      } else {
        const roomGone = after.length === 0;
        record('10-end', closed && roomGone ? 'PASS' : 'FAIL', `registryClosed=${closed} roomBefore=${before.length} roomAfter=${after.length}`);
      }
    } catch (err) {
      record('10-end', 'FAIL', err instanceof Error ? err.message : String(err));
    }
  }

  // Always disconnect the probe on the way out, whether step 10 ran or was
  // skipped — a dangling LiveKit client would otherwise hold the room open.
  if (probe) {
    try {
      await probe.room.disconnect();
    } catch {
      /* best effort */
    }
  }

  summarizeAndExit();
}

main().catch((err) => {
  console.error('UNEXPECTED FAILURE:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
