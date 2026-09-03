/**
 * P2.1 — the number the whole project is justified by.
 *
 * "Splitting the Harness" is explicit that the existing instrument cannot see
 * the thing being fixed: `bootMark()` stamps every mark as
 * `Date.now() - bootTime`, where bootTime is PROCESS START INSIDE THE GUEST.
 * VM allocation and rootfs restore both finish before that clock starts, so the
 * boot timeline is blind to the single largest cost the small image removes.
 *
 * This clock starts OUTSIDE, before the API is even called, which makes it a
 * strict superset of the API-side clock the doc asks for: it spans provider
 * scheduling, rootfs restore, boot, and the model's own time to first token.
 *
 * It measures four phases, so a result can be attributed rather than just
 * reported:
 *
 *   create   POST /sessions accepted
 *   ready    a sandbox_url exists and its health answers
 *   prompt   the prompt is accepted
 *   token    the FIRST assistant text arrives  <- what a user actually waits for
 *
 * It also reads back the API's own `session_start_timeline` where present, so
 * the host-side breakdown sits beside the wall clock instead of contradicting
 * it silently.
 *
 * Usage:
 *   bun ttft-bench.ts --base https://pi.kortix.com/v1 --project <uuid> \
 *      --jwt "$(cat /tmp/jwt.txt)" --runs 10 --label "pi worker (cold)"
 */

interface RunResult {
  run: number;
  ok: boolean;
  sessionId?: string;
  createMs?: number;
  readyMs?: number;
  promptMs?: number;
  tokenMs?: number;
  /** --tool mode: the first tool RESULT arrives — environment reachable AND the command ran. */
  toolMs?: number;
  totalMs?: number;
  serverTimelineMs?: number | null;
  provider?: string | null;
  error?: string;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const BASE = arg('base');
const PROJECT = arg('project');
const JWT = arg('jwt');
const RUNS = Number(arg('runs', '10'));
const LABEL = arg('label', 'unlabelled');
/**
 * --tool: clock the first TOOL RESULT as well as the first token.
 *
 * P2.2's leg. The split moved the environment's cold start out of session
 * setup and into the middle of the first answer (measured 37.5s to the first
 * `bash` on a cold session before the prompt-time prewarm). This mode forces
 * one `bash` call and stamps the moment its result comes back — provisioning,
 * daemon readiness, repo materialisation and the command itself, end to end.
 */
const TOOL = process.argv.includes('--tool');
/**
 * --keep: leave the benchmark sessions running. By default each run STOPS its
 * session once measured — ten runs a day against one project otherwise walk
 * straight into the 100-active-sessions cap (`create 429`), which is exactly
 * how the fourth run of a ten-run clock failed on 2026-09-03.
 */
const KEEP = process.argv.includes('--keep');
const PROMPT = arg(
  'prompt',
  TOOL
    ? 'Use the bash tool to run exactly this command: echo KORTIX-TOOL-PROBE . Then reply with only its output.'
    : 'Reply with exactly the word READY and nothing else.',
);
/** 'pi' streams its own turn; 'opencode' needs a concurrent listener on /event. */
const RUNTIME = arg('runtime', 'pi') as 'pi' | 'opencode';
const H = { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Percentile over a sorted copy; p50 of an even count takes the lower middle. */
function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

/**
 * OpenCode does not stream the prompt response, so the listener has to be open
 * BEFORE the message is posted — otherwise the first token can land while the
 * subscription is still connecting and the measurement silently reports the
 * second one.
 */
async function opencodeFirstToken(
  sandboxUrl: string,
  t0: number,
): Promise<{ promptMs?: number; tokenMs?: number; error?: string }> {
  const auth = { authorization: H.authorization };
  const list = await fetch(`${sandboxUrl}/session`, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!list.ok) return { error: `session list ${list.status}` };
  const sessions = (await list.json()) as Array<{ id?: string }>;
  const osid = sessions?.[0]?.id;
  if (!osid) return { error: 'no opencode session' };

  const ac = new AbortController();
  let tokenMs: number | undefined;
  const watcher = (async () => {
    const ev = await fetch(`${sandboxUrl}/event`, { headers: auth, signal: ac.signal });
    if (!ev.ok || !ev.body) return;
    const reader = ev.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let e: any;
        try {
          e = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        const part = e?.properties?.part;
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          tokenMs = performance.now() - t0;
          return;
        }
      }
      const nl = buf.lastIndexOf('\n');
      if (nl > 0) buf = buf.slice(nl);
    }
  })().catch(() => undefined);

  // Give the subscription a moment to be established before prompting.
  await sleep(300);
  const promptRes = await fetch(`${sandboxUrl}/session/${osid}/message`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: PROMPT }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const promptMs = performance.now() - t0;
  if (!promptRes.ok) {
    ac.abort();
    return { promptMs, error: `prompt ${promptRes.status}: ${(await promptRes.text()).slice(0, 140)}` };
  }
  // The POST resolves with the finished message; if the watcher already saw a
  // delta we keep its earlier mark, otherwise fall back to completion.
  const deadline = performance.now() + 20_000;
  while (tokenMs === undefined && performance.now() < deadline) await sleep(25);
  ac.abort();
  await watcher;
  return { promptMs, tokenMs: tokenMs ?? performance.now() - t0 };
}

async function oneRun(run: number): Promise<RunResult> {
  const t0 = performance.now();
  try {
    // ---- create -----------------------------------------------------------
    const createRes = await fetch(`${BASE}/projects/${PROJECT}/sessions`, {
      method: 'POST',
      headers: H,
      body: '{}',
      signal: AbortSignal.timeout(300_000),
    });
    if (!createRes.ok) {
      return { run, ok: false, error: `create ${createRes.status}: ${(await createRes.text()).slice(0, 160)}` };
    }
    const created = (await createRes.json()) as { session_id?: string; sandbox_provider?: string };
    const sessionId = created.session_id;
    if (!sessionId) return { run, ok: false, error: 'no session_id' };
    const createMs = performance.now() - t0;

    // ---- ready ------------------------------------------------------------
    let sandboxUrl = '';
    const readyDeadline = performance.now() + 300_000;
    while (performance.now() < readyDeadline) {
      const r = await fetch(`${BASE}/projects/${PROJECT}/sessions/${sessionId}`, {
        headers: H,
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) {
        const row = (await r.json()) as { sandbox_url?: string };
        if (row.sandbox_url) {
          sandboxUrl = row.sandbox_url;
          break;
        }
      }
      await sleep(250);
    }
    if (!sandboxUrl) return { run, ok: false, sessionId, error: 'never became reachable' };

    // The runtime must actually answer before a prompt means anything.
    while (performance.now() < readyDeadline) {
      try {
        const h = await fetch(`${sandboxUrl}/kortix/health`, {
          headers: { authorization: H.authorization },
          signal: AbortSignal.timeout(15_000),
        });
        if (h.ok) {
          const body = (await h.json()) as { runtimeReady?: boolean };
          if (body.runtimeReady !== false) break;
        }
      } catch {
        // still coming up
      }
      await sleep(250);
    }
    const readyMs = performance.now() - t0;

    // ---- prompt + first token --------------------------------------------
    if (RUNTIME === 'opencode') {
      const r = await opencodeFirstToken(sandboxUrl, t0);
      const totalMsOc = performance.now() - t0;
      return {
        run,
        ok: r.tokenMs !== undefined,
        sessionId,
        createMs,
        readyMs,
        promptMs: r.promptMs,
        tokenMs: r.tokenMs,
        totalMs: totalMsOc,
        serverTimelineMs: null,
        provider: created.sandbox_provider ?? null,
        error: r.error,
      };
    }
    const turn = await fetch(`${sandboxUrl}/turn`, {
      method: 'POST',
      headers: { authorization: H.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ text: PROMPT }),
      signal: AbortSignal.timeout(300_000),
    });
    const promptMs = performance.now() - t0;
    if (!turn.ok || !turn.body) {
      return { run, ok: false, sessionId, createMs, readyMs, error: `turn ${turn.status}` };
    }

    // Read the SSE until the first assistant TEXT — not the first frame. A
    // `message_start` with empty content is not something a user can read.
    let tokenMs: number | undefined;
    let toolMs: number | undefined;
    const reader = turn.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let evt: any;
        try {
          evt = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (TOOL && evt?.type === 'tool_execution_end' && toolMs === undefined) {
          toolMs = performance.now() - t0;
        }
        const parts = evt?.message?.content;
        if (evt?.message?.role === 'assistant' && Array.isArray(parts)) {
          const text = parts.map((p: any) => (p?.type === 'text' ? p.text ?? '' : '')).join('');
          if (text.length > 0 && tokenMs === undefined) tokenMs = performance.now() - t0;
        }
        // Token mode stops at the first text; tool mode needs the tool result too.
        if (tokenMs !== undefined && (!TOOL || toolMs !== undefined)) break outer;
      }
      // Keep only the tail so a split frame is not lost between reads.
      const lastNewline = buffered.lastIndexOf('\n');
      if (lastNewline > 0) buffered = buffered.slice(lastNewline);
    }
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
    const totalMs = performance.now() - t0;

    // ---- the API's own view, for attribution ------------------------------
    let serverTimelineMs: number | null = null;
    let provider: string | null = created.sandbox_provider ?? null;
    try {
      const r = await fetch(`${BASE}/projects/${PROJECT}/sessions/${sessionId}`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        const row = (await r.json()) as any;
        provider = row?.sandbox_provider ?? provider;
        const t =
          row?.metadata?.session_start_timeline?.totalMs ??
          row?.session_start_timeline?.totalMs ??
          null;
        serverTimelineMs = typeof t === 'number' ? t : null;
      }
    } catch {
      // attribution is a bonus, never the measurement
    }

    if (!KEEP) {
      // Fire-and-forget: the measurement is over; a slow stop must not skew the
      // next run's create clock, and a failed stop is the cap's problem later.
      void fetch(`${BASE}/projects/${PROJECT}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: H,
        signal: AbortSignal.timeout(120_000),
      }).catch(() => {});
    }
    return { run, ok: tokenMs !== undefined && (!TOOL || toolMs !== undefined), sessionId, createMs, readyMs, promptMs, tokenMs, toolMs, totalMs, serverTimelineMs, provider };
  } catch (err) {
    return { run, ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

const results: RunResult[] = [];
console.log(`\n=== ${LABEL} — ${RUNS} runs against ${BASE} ===`);
console.log(`run  create    ready    prompt    TOKEN   ${TOOL ? ' TOOL     ' : ''}server-tl  status`);
for (let i = 1; i <= RUNS; i++) {
  const r = await oneRun(i);
  results.push(r);
  const f = (v?: number) => (v === undefined ? '     —' : `${(v / 1000).toFixed(2)}s`.padStart(7));
  console.log(
    `${String(i).padStart(3)}  ${f(r.createMs)}  ${f(r.readyMs)}  ${f(r.promptMs)}  ${f(r.tokenMs)}  ${TOOL ? `${f(r.toolMs)}  ` : ''}` +
      `${r.serverTimelineMs === null || r.serverTimelineMs === undefined ? '     —' : `${(r.serverTimelineMs / 1000).toFixed(2)}s`.padStart(7)}  ` +
      `${r.ok ? 'ok' : `FAIL ${r.error ?? ''}`}`,
  );
}

const ok = results.filter((r) => r.ok && r.tokenMs !== undefined);
const tokens = ok.map((r) => r.tokenMs!);
const readies = ok.map((r) => r.readyMs!);
console.log(`\n--- ${LABEL} ---`);
console.log(`runs            ${results.length} (${ok.length} usable, ${results.length - ok.length} failed)`);
if (ok.length > 0) {
  console.log(`TIME TO FIRST TOKEN  p50 ${(pct(tokens, 50) / 1000).toFixed(2)}s   p95 ${(pct(tokens, 95) / 1000).toFixed(2)}s   min ${(Math.min(...tokens) / 1000).toFixed(2)}s   max ${(Math.max(...tokens) / 1000).toFixed(2)}s`);
  console.log(`  of which, to ready p50 ${(pct(readies, 50) / 1000).toFixed(2)}s`);
  if (TOOL) {
    const tools = ok.map((r) => r.toolMs!);
    console.log(`TIME TO FIRST TOOL RESULT  p50 ${(pct(tools, 50) / 1000).toFixed(2)}s   p95 ${(pct(tools, 95) / 1000).toFixed(2)}s   min ${(Math.min(...tools) / 1000).toFixed(2)}s   max ${(Math.max(...tools) / 1000).toFixed(2)}s`);
  }
  console.log(`  provider ${ok[0]!.provider ?? 'unknown'}`);
}
await Bun.write(
  `/tmp/ttft-${LABEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`,
  JSON.stringify({ label: LABEL, base: BASE, project: PROJECT, results }, null, 2),
);
console.log(`raw: /tmp/ttft-${LABEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);
