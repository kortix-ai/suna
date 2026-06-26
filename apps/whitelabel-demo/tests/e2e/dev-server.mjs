import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const port = Number(process.env.WHITELABEL_PORT ?? 3010);
const mockPort = Number(process.env.WHITELABEL_MOCK_API_PORT ?? 3108);
const useRealBackend = process.env.WHITELABEL_E2E_REAL_BACKEND === '1';
const dataDir = process.env.WHITELABEL_DATA_DIR ?? path.join(process.cwd(), '.data', 'e2e');

const projects = new Map();
const sessions = new Map();

// How long the mock "agent" takes to finish a turn. While a turn is in
// progress the session reports `running`; once done it reports `completed`,
// which is how the event stream knows to stop — exactly like the real backend.
const INITIAL_DURATION = 3800;

function durationFor(turn) {
  if (turn.kind === 'initial') return INITIAL_DURATION;
  return turn.intent === 'build' ? 2700 : 1300;
}

const BUILD_RE = /\b(build|create|make|add|write|implement|set ?up|generate|scaffold|fix|update|change|refactor|design|rename|delete|remove|install)\b/i;
const QUESTION_RE = /^(what|why|how|is|are|can|could|does|do|should|where|when|who|which|will)\b|\?\s*$/i;

function intentOf(prompt) {
  const p = prompt.trim();
  if (BUILD_RE.test(p)) return 'build';
  if (QUESTION_RE.test(p)) return 'question';
  return 'chat';
}

function guessFile(prompt) {
  const s = prompt.toLowerCase();
  if (/readme/.test(s)) return 'README.md';
  if (/website|landing|page|site|html|frontend|\bui\b/.test(s)) return 'index.html';
  if (/api|endpoint|route|server|backend/.test(s)) return 'src/server.ts';
  if (/test|spec/.test(s)) return 'src/app.test.ts';
  if (/style|css|theme|design/.test(s)) return 'styles.css';
  if (/config|setup|env/.test(s)) return 'config.ts';
  return 'src/app.ts';
}

function pick(arr, seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return arr[Math.abs(h) % arr.length];
}

function statusFor(session) {
  const latest = session.turns[session.turns.length - 1];
  if (!latest) return 'running';
  return Date.now() - latest.at >= durationFor(latest) ? 'completed' : 'running';
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sessionPayload(session) {
  return {
    session_id: session.sessionId,
    project_id: session.projectId,
    branch_name: session.sessionId,
    sandbox_provider: 'mock',
    sandbox_id: session.sessionId,
    sandbox_url: `http://mock.local/p/${session.sessionId}/8000/`,
    opencode_session_id: `oc-${session.sessionId.slice(0, 8)}`,
    name: session.name,
    agent_name: 'default',
    status: statusFor(session),
    error: null,
    metadata: session.metadata,
    created_at: session.createdAt,
    updated_at: new Date().toISOString(),
  };
}

function message(role, atMs, text, extra = {}) {
  return {
    role,
    created: new Date(atMs).toISOString(),
    completed: extra.completed === undefined ? new Date(atMs + 200).toISOString() : extra.completed,
    text,
    tools: extra.tools ?? [],
    files: extra.files ?? [],
    reasoning_omitted: Boolean(extra.reasoning),
    error: null,
  };
}

function followupMessages(turn, out) {
  const elapsed = Date.now() - turn.at;
  const at = (ms) => turn.at + ms;
  const file = turn.file;

  if (turn.intent === 'build') {
    const ack = pick(['Sure — on it.', 'Got it, making that change now.', 'On it.'], turn.text);
    const verb = /\.(md|txt)$/.test(file) ? 'edit' : 'write';
    if (elapsed > 400) out.push(message('assistant', at(400), ack, { reasoning: true }));
    if (elapsed > 1100)
      out.push(
        message('tool', at(1100), `${verb === 'edit' ? 'Editing' : 'Writing'} \`${file}\`.`, {
          tools: [{ tool: verb, status: elapsed > 2000 ? 'completed' : 'running' }],
          completed: elapsed > 2000 ? new Date(at(2000)).toISOString() : null,
        }),
      );
    if (elapsed > 2300)
      out.push(
        message(
          'assistant',
          at(2300),
          pick(
            [
              `Done — updated \`${file}\`. Take a look and tell me if you want any changes.`,
              `\`${file}\` is in place. Want me to keep going or adjust anything?`,
              `Applied that to \`${file}\`. Anything else you'd like me to do?`,
            ],
            turn.text,
          ),
          { files: [{ filename: file, mime: 'text/plain' }] },
        ),
      );
    return out;
  }

  if (turn.intent === 'question') {
    if (elapsed > 700)
      out.push(
        message(
          'assistant',
          at(700),
          pick(
            [
              'Yes — this is live. Your message goes to the session and the reply streams straight back, just like the core app.',
              "Short answer: yes. The frontend posts to the backend session and streams the agent's response in real time.",
              "It's working — what you're seeing is a real round-trip to the session, not a canned reply path.",
            ],
            turn.text,
          ),
        ),
      );
    return out;
  }

  // plain chat
  if (elapsed > 600)
    out.push(
      message(
        'assistant',
        at(600),
        pick(
          ['Got it.', 'Sounds good — what should I change first?', 'Makes sense. Want me to make a change?'],
          turn.text,
        ),
      ),
    );
  return out;
}

function turnMessages(turn) {
  const elapsed = Date.now() - turn.at;
  const at = (ms) => turn.at + ms;
  const out = [];

  if (turn.kind === 'followup') {
    out.push(message('user', turn.at, turn.text));
    return followupMessages(turn, out);
  }

  // initial turn — a short, representative agent run
  if (elapsed > 400)
    out.push(
      message(
        'assistant',
        at(400),
        'On it — let me take a look at the project before making any changes.',
        { reasoning: true },
      ),
    );
  if (elapsed > 1100)
    out.push(
      message('tool', at(1100), 'Read `package.json` and the existing `README.md`.', {
        tools: [{ tool: 'read', status: 'completed' }],
      }),
    );
  if (elapsed > 2100)
    out.push(
      message('tool', at(2100), 'Editing `README.md` to add a short project overview.', {
        tools: [{ tool: 'edit', status: elapsed > 3000 ? 'completed' : 'running' }],
        completed: elapsed > 3000 ? new Date(at(3000)).toISOString() : null,
      }),
    );
  if (elapsed > 3400)
    out.push(
      message(
        'assistant',
        at(3400),
        'Done — I added a concise overview to the README that explains what the project is and how to run it. Want me to expand it or change anything else?',
        { files: [{ filename: 'README.md', mime: 'text/markdown' }] },
      ),
    );
  return out;
}

function createMockApi() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${mockPort}`);
    if (!req.headers.authorization) return json(res, 401, { error: 'missing auth' });

    if (req.method === 'POST' && url.pathname === '/v1/projects/provision') {
      const body = await readBody(req);
      const projectId = randomUUID();
      const project = {
        project_id: projectId,
        name: body.name ?? 'Workspace',
        repo_url: `https://git.example/${projectId}.git`,
        git_origin_url: `https://git.example/${projectId}.git`,
        default_branch: 'main',
        seeded: body.seed_starter === true,
      };
      projects.set(projectId, project);
      return json(res, 201, project);
    }

    const sessionCreate = url.pathname.match(/^\/v1\/projects\/([^/]+)\/sessions$/);
    if (req.method === 'POST' && sessionCreate) {
      const projectId = sessionCreate[1];
      if (!projects.has(projectId)) return json(res, 404, { error: 'project not found' });
      const body = await readBody(req);
      const sessionId = randomUUID();
      const now = new Date().toISOString();
      const session = {
        sessionId,
        projectId,
        name: body.name ?? 'Workspace session',
        metadata: body.metadata ?? {},
        createdAt: now,
        updatedAt: now,
        turns: [{ kind: 'initial', text: body.initial_prompt ?? '', at: Date.now() }],
      };
      sessions.set(sessionId, session);
      return json(res, 201, sessionPayload(session));
    }

    const startMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/start$/);
    if (req.method === 'POST' && startMatch) {
      const session = sessions.get(startMatch[2]);
      if (!session) return json(res, 404, { error: 'session not found' });
      return json(res, 200, {
        status: 'ready',
        sessionId: session.sessionId,
        retryable: false,
        start: {
          stage: 'ready',
          retriable: false,
          opencode_session_id: `oc-${session.sessionId.slice(0, 8)}`,
          sandbox: {
            external_id: session.sessionId,
            status: 'active',
            base_url: `http://mock.local/p/${session.sessionId}/8000/`,
          },
        },
      });
    }

    const transcriptMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/transcript$/);
    if (req.method === 'GET' && transcriptMatch) {
      const session = sessions.get(transcriptMatch[2]);
      if (!session) return json(res, 404, { error: 'session not found' });
      const messages = session.turns.flatMap(turnMessages);
      return json(res, 200, {
        available: true,
        reason: messages.length ? null : 'Waiting for the agent to start.',
        opencode_session_id: `oc-${session.sessionId.slice(0, 8)}`,
        message_count: messages.length,
        messages,
      });
    }

    const sessionGet = url.pathname.match(/^\/v1\/projects\/([^/]+)\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && sessionGet) {
      const session = sessions.get(sessionGet[2]);
      if (!session) return json(res, 404, { error: 'session not found' });
      return json(res, 200, sessionPayload(session));
    }

    // OpenCode message endpoint (via sandbox proxy). POST = send a prompt to the
    // agent; the next turn then streams back through the transcript.
    const messagePath = url.pathname.match(/^\/v1\/p\/([^/]+)\/8000\/session\/([^/]+)\/message$/);
    if (messagePath) {
      const session = sessions.get(messagePath[1]);
      if (!session) return json(res, 404, { error: 'session not found' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const text =
          (Array.isArray(body.parts) ? body.parts.find((p) => p?.type === 'text')?.text : null) ??
          body.text ??
          '';
        const promptText = String(text);
        session.turns.push({
          kind: 'followup',
          text: promptText,
          at: Date.now(),
          intent: intentOf(promptText),
          file: guessFile(promptText),
        });
        session.updatedAt = new Date().toISOString();
        return json(res, 200, { ok: true });
      }
      return json(res, 200, []);
    }

    return json(res, 404, { error: 'not found', path: url.pathname });
  });
}

await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

let mockServer;
if (!useRealBackend) {
  mockServer = createMockApi();
  await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve));
}

const child = spawn('pnpm', ['dev'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    WHITELABEL_PORT: String(port),
    WHITELABEL_DATA_DIR: dataDir,
    WHITELABEL_KORTIX_TOKEN: process.env.WHITELABEL_KORTIX_TOKEN ?? 'kortix_pat_mock',
    WHITELABEL_KORTIX_API_URL:
      process.env.WHITELABEL_KORTIX_API_URL ?? `http://127.0.0.1:${mockPort}/v1`,
  },
});

function shutdown(signal) {
  if (mockServer) mockServer.close();
  child.kill(signal);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
child.on('exit', (code) => {
  if (mockServer) mockServer.close();
  process.exit(code ?? 0);
});
