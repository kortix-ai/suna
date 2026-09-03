import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { __resetPiWorkerBundleForTests, getPiWorkerBundle } from './pi-worker-bundle';
import { compilePiRuntime } from './compiled-pi-runtime';

const WORKER_DIST = resolve(
  import.meta.dir,
  '../../../kortix-worker/dist/worker-runtime.mjs',
);

const roots: string[] = [];
afterEach(async () => {
  __resetPiWorkerBundleForTests();
  delete process.env.KORTIX_PI_WORKER_BUNDLE_PATH;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('getPiWorkerBundle', () => {
  test('rejects a bundle without the worker entrypoint sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-bundle-'));
    roots.push(root);
    const bogus = join(root, 'bogus.mjs');
    await writeFile(bogus, 'console.log("not a worker");\n');
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = bogus;
    expect(getPiWorkerBundle()).rejects.toThrow(/no worker entrypoint/);
  });

  test('a failed load does not poison later loads', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = '/nonexistent/worker.mjs';
    await expect(getPiWorkerBundle()).rejects.toThrow();
    // Point at a valid bundle and the next call must succeed.
    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-bundle-'));
    roots.push(root);
    const ok = join(root, 'ok.mjs');
    await writeFile(ok, 'console.log("kortix-worker starting");\n');
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = ok;
    const bundle = await getPiWorkerBundle();
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// The end-to-end shape the pipeline exists to produce: the REAL worker runtime
// (apps/kortix-worker/dist), compiled with a project's baked config, booted as
// the artifact would boot in a worker sandbox, serving /health. Skipped when
// the dist bundle has not been built (CI builds it in the Docker stage; run
// `bun run build` in apps/kortix-worker locally).
describe.skipIf(!existsSync(WORKER_DIST))('compiled pi runtime artifact (real bundle)', () => {
  test('boots under node and serves /health with the baked identity', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = WORKER_DIST;
    const bundle = await getPiWorkerBundle();
    const artifact = compilePiRuntime({
      projectId: 'project-e2e',
      ref: 'main',
      sourceSha: 'b'.repeat(40),
      agentConfig: JSON.stringify({
        agent: { dev: { prompt: 'You are the compiled dev agent.' } },
      }),
      defaultAgent: 'dev',
      workerBundle: bundle.source,
    });

    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-e2e-'));
    roots.push(root);
    const runtimePath = join(root, 'worker.mjs');
    await writeFile(runtimePath, artifact.source, { mode: 0o700 });

    const port = 18300 + Math.floor(Math.random() * 500);
    const child = spawn('node', [runtimePath], {
      env: {
        ...process.env,
        PORT: String(port),
        KORTIX_MODEL_MODE: 'faux',
        KORTIX_PROJECT_ID: 'project-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let health: { ok?: boolean; confined?: boolean } | null = null;
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            health = (await res.json()) as { ok?: boolean; confined?: boolean };
            break;
          }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(health?.ok).toBe(true);
      // Started bare (no --permission) on purpose: the field must say so rather
      // than echo what the entrypoint would have passed.
      expect(health?.confined).toBe(false);
      // The double-start regression crashed the process ~immediately AFTER
      // health first answered, so a single poll flaky-passed. Survival for a
      // beat plus a second answer is the actual assertion.
      await new Promise((r) => setTimeout(r, 1500));
      expect(child.exitCode).toBeNull();
      const again = await fetch(`http://127.0.0.1:${port}/health`);
      expect(again.ok).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);
});

// The Kortix Runtime API on the worker (/kortix/opencode/*): the surface the
// web session page reads since #6987 — /state, paged /messages, the sequenced
// /events SSE — served by the REAL compiled artifact, driven through a real
// faux turn. Skipped like the sibling when dist has not been built.
describe.skipIf(!existsSync(WORKER_DIST))('compiled pi runtime — session read surface', () => {
  test('a turn renders: transcript, state, sequenced events, health identity', async () => {
    process.env.KORTIX_PI_WORKER_BUNDLE_PATH = WORKER_DIST;
    const bundle = await getPiWorkerBundle();
    const artifact = compilePiRuntime({
      projectId: 'project-e2e',
      ref: 'main',
      sourceSha: 'c'.repeat(40),
      agentConfig: JSON.stringify({
        agent: { dev: { prompt: 'You are the compiled dev agent.', model: 'openrouter/anthropic/claude-sonnet-4.5' } },
      }),
      defaultAgent: 'dev',
      workerBundle: bundle.source,
    });
    const root = await mkdtemp(join(tmpdir(), 'kortix-pi-read-'));
    roots.push(root);
    const runtimePath = join(root, 'worker.mjs');
    await writeFile(runtimePath, artifact.source, { mode: 0o700 });

    const port = 18900 + Math.floor(Math.random() * 500);
    const TOKEN = 'read-surface-token';
    const child = spawn('node', [runtimePath], {
      env: {
        ...process.env,
        PORT: String(port),
        KORTIX_MODEL_MODE: 'faux',
        KORTIX_PROJECT_ID: 'project-e2e',
        KORTIX_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        KORTIX_TOKEN: TOKEN,
        KORTIX_AGENT: 'dev',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `http://127.0.0.1:${port}`;
    const authed = { headers: { authorization: `Bearer ${TOKEN}` } };
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 50));
      }
      expect(up).toBe(true);

      // Health advertises the minted pi root as the native conversation id —
      // the id the whole client transcript machinery keys on (it must not be
      // a project-session UUID).
      const health = (await (await fetch(`${base}/kortix/health`)).json()) as {
        opencode_session_id?: string;
      };
      const rootId = health.opencode_session_id ?? '';
      expect(rootId.startsWith('ses_pi')).toBe(true);

      // Auth: no bearer, no user-context → 401.
      const denied = await fetch(`${base}/kortix/opencode/state`);
      expect(denied.status).toBe(401);

      // Drive one scripted faux turn. The bench surface is gated on a worker
      // that HAS a credential (this one does): those routes used to be the only
      // ones on the box with no auth at all, so a caller that reached the port
      // could inject a prompt or read the whole transcript. A tokenless bench
      // worker keeps them open — there is nothing to protect — which is why
      // `requiresAuth()` and not a bare `authorize()` guards them.
      const turn = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'render me', script: [{ text: 'rendered, chief' }] }),
      });
      expect(turn.ok).toBe(true);

      // ...and without the credential it is refused, like every sibling route.
      const promptDenied = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'nope' }),
      });
      expect(promptDenied.status).toBe(401);

      // Transcript: user + assistant, ids unique and sorted, text present.
      const page = (await (
        await fetch(`${base}/kortix/opencode/messages/${rootId}?limit=20`, authed)
      ).json()) as {
        messages: Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }>;
        has_more: boolean;
        epoch: string;
        seq: number;
      };
      const roles = page.messages.map((m) => m.info.role);
      // EXACTLY one user message: pi emits its own user message_start, which
      // the adapter must skip (the worker publishes the user turn itself) —
      // the duplicate rendered as an empty second bubble on dev.
      expect(roles.filter((r) => r === 'user')).toEqual(['user']);
      expect(roles).toContain('assistant');
      const ids = page.messages.map((m) => m.info.id);
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      const assistant = page.messages.find((m) => m.info.role === 'assistant');
      expect(assistant?.parts.some((p) => p.type === 'text' && p.text === 'rendered, chief')).toBe(true);
      expect(page.seq).toBeGreaterThan(0);

      // Raw /session list — the control plane's pin probe
      // (ensureOpencodeSessionPin) reads THIS to resolve /start to 'ready';
      // without it the healthy box parks at the 90s no-progress budget.
      const rawList = (await (
        await fetch(`${base}/session?directory=%2Fworkspace`, authed)
      ).json()) as Array<{ id: string; title: string }>;
      expect(rawList.map((s) => s.id)).toEqual([rootId]);
      const rawDenied = await fetch(`${base}/session`);
      expect(rawDenied.status).toBe(401);
      // Only user/assistant roles reach the transcript — pi's toolResult
      // messages ride as tool PARTS, never as their own rows.
      expect(new Set(roles).size).toBeLessThanOrEqual(2);

      // State: identity + roster + idle status for the root.
      const state = (await (await fetch(`${base}/kortix/opencode/state`, authed)).json()) as {
        identity: { opencode_session_id: string };
        agents: { known: boolean; value: Array<{ name: string; model: { providerID: string } | null }> };
        sessions: { value: Array<{ id: string; title: string }> };
        statuses: { value: Record<string, { type: string }> };
      };
      expect(state.identity.opencode_session_id).toBe(rootId);
      expect(state.agents.value.map((a) => a.name)).toEqual(['dev']);
      expect(state.agents.value[0]?.model?.providerID).toBe('openrouter');
      expect(state.sessions.value[0]?.id).toBe(rootId);
      expect(state.statuses.value[rootId]?.type).toBe('idle');
      // The first user line names the session.
      expect(state.sessions.value[0]?.title).toBe('render me');

      // Events: full replay from 0 — message frames present, seqs dense-ish
      // and increasing, hello first.
      const sse = await fetch(`${base}/kortix/opencode/events?since=0`, authed);
      expect(sse.headers.get('x-kortix-epoch')).toBe(page.epoch);
      const reader = sse.body!.getReader();
      let buffer = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !buffer.includes('session.idle')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
      }
      await reader.cancel().catch(() => {});
      expect(buffer.startsWith('event: kortix.hello')).toBe(true);
      expect(buffer).toContain('event: message.updated');
      expect(buffer).toContain('event: message.part.updated');
      expect(buffer).toContain('rendered, chief');
      const seqs = [...buffer.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(seqs.length).toBeGreaterThan(2);
      // The COMPOSER delivery route: the API sends every composer/queue prompt
      // to POST /session/:rootId/prompt_async (engine.ts postPrompt), 204 +
      // background turn. This is the route that was 404ing, so the user never
      // got a reply. Drive it with a scripted faux turn and the API's wire id.
      const wireId = 'msg_wire00000001';
      const asyncRes = await fetch(`${base}/session/${rootId}/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authed.headers },
        body: JSON.stringify({ messageID: wireId, parts: [{ type: 'text', text: 'over the composer route' }] }),
      });
      expect(asyncRes.status).toBe(204);
      // The turn runs in the background; poll the transcript until it settles.
      let asyncPage: any = null;
      for (let i = 0; i < 100; i++) {
        asyncPage = await (
          await fetch(`${base}/kortix/opencode/messages/${rootId}?limit=40`, authed)
        ).json();
        const roles = asyncPage.messages.map((m: any) => m.info.role);
        if (roles.filter((r: string) => r === 'user').length >= 1 && roles.includes('assistant')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // The user message reused the API's wire id verbatim (the turn oracle keys on it).
      const userMsg = asyncPage.messages.find((m: any) => m.info.role === 'user' && m.info.id === wireId);
      expect(userMsg).toBeDefined();
      expect(userMsg.parts.some((p: any) => p.type === 'text' && p.text === 'over the composer route')).toBe(true);
      // The health turn probe reported the in-flight turn under that id while it ran.
      const probe = await (
        await fetch(`${base}/kortix/health?turn=1&turn_message_id=${wireId}`)
      ).json();
      expect(probe).toHaveProperty('turn_in_flight');

      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);
});
