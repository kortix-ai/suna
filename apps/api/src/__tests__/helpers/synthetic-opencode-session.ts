// A synthetic OpenCode session as `GET /session/:id/message` returns it: every
// value is invented. It holds the shapes the v1 read paths serve: text,
// reasoning, completed / failed / interrupted tool calls with metadata, step
// tokens, a patch part, an image file part with a `data:` url (the capture drops
// it), a manual compaction with its summary, an aborted reply, and a `task`
// sub-agent whose own session the capture saves as a child.

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const T0 = 1_790_000_000_000;
const MODEL = { providerID: 'kortix', modelID: 'synthetic-model' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function syntheticOpencodeSession(input: { root: string; child: string; turns: number }) {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${String(++n).padStart(12, '0')}`;
  const at = () => T0 + n * 1_000;
  const root: Message[] = [];
  const child: Message[] = [];

  const user = (sid: string, text: string, extra: Array<Record<string, unknown>> = []): Message => {
    const mid = id('msg');
    const info = { id: mid, sessionID: sid, role: 'user', time: { created: at() }, agent: 'build', model: MODEL };
    const parts = [{ id: id('prt'), sessionID: sid, messageID: mid, type: 'text', text }, ...extra.map((p) => ({ id: id('prt'), sessionID: sid, messageID: mid, ...p }))];
    return { info, parts };
  };
  const assistant = (sid: string, parentID: string, parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Message => {
    const mid = id('msg');
    const created = at();
    const info = {
      id: mid, sessionID: sid, role: 'assistant', time: { created, completed: created + 900 }, parentID, ...MODEL,
      mode: 'build', agent: 'build', path: { cwd: '/workspace', root: '/workspace' }, cost: 0.0012,
      tokens: { input: 1200, output: 80, reasoning: 12, cache: { read: 300, write: 0 } }, finish: 'stop', ...extra,
    };
    return { info, parts: parts.map((p) => ({ id: id('prt'), sessionID: sid, messageID: mid, ...p })) };
  };
  const step = (tokens: number) => [
    { type: 'step-start', snapshot: `snap${tokens}` },
    { type: 'step-finish', reason: 'stop', snapshot: `snap${tokens + 1}`, cost: 0.0006, tokens: { input: tokens, output: 40, reasoning: 6, cache: { read: 150, write: 0 } } },
  ];
  const bash = (command: string, output: string, start: number) => ({
    type: 'tool', callID: `call_${start}`, tool: 'bash',
    state: { status: 'completed', input: { command, description: 'Run a command' }, output, title: command, metadata: { exit: 0, output, description: 'Run a command' }, time: { start, end: start + 40 } },
  });

  for (let i = 0; i < input.turns; i++) {
    const u = user(input.root, `Prompt ${i}: list the files and summarize them.`, i === 4 ? [{ type: 'file', mime: 'image/png', filename: 'dot.png', url: PNG }] : []);
    root.push(u);
    if (i === Math.floor(input.turns / 2)) {
      const marker = user(input.root, 'compact', []);
      marker.parts = [{ id: id('prt'), sessionID: input.root, messageID: marker.info.id, type: 'compaction', auto: false }];
      root.push(marker);
      const summary = assistant(input.root, String(marker.info.id), [{ type: 'text', text: `SUMMARY up to turn ${i}.` }], { mode: 'compaction', agent: 'compaction', summary: true });
      root.push(summary);
    }
    const [start, finish] = step(1000 + i);
    const t = at();
    const tools: Array<Record<string, unknown>> = [bash(`ls -la dir${i}`, `file-${i}.txt\nREADME.md`, t)];
    if (i === 1) {
      tools.push({
        type: 'tool', callID: `call_task_${t}`, tool: 'task',
        state: { status: 'completed', input: { description: 'list files', prompt: 'List the files.', subagent_type: 'general' }, output: `task_id: ${input.child}`, title: 'list files', metadata: { sessionId: input.child }, time: { start: t, end: t + 500 } },
      });
      const cu = user(input.child, 'List the files.');
      child.push(cu, assistant(input.child, String(cu.info.id), [...step(50), { type: 'text', text: 'README.md' }]));
    }
    if (i === 2) {
      tools.push({ type: 'tool', callID: `call_err_${t}`, tool: 'bash', state: { status: 'error', input: { command: 'false' }, error: 'exit 1', metadata: { exit: 1 }, time: { start: t, end: t + 5 } } });
    }
    if (i === 3) {
      // A stopped reply: its running call never ended.
      root.push(assistant(input.root, String(u.info.id), [start!, { type: 'tool', callID: `call_run_${t}`, tool: 'bash', state: { status: 'running', input: { command: 'sleep 30' }, time: { start: t } } }], {
        time: { created: t }, finish: undefined, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } },
      }));
      continue;
    }
    root.push(assistant(input.root, String(u.info.id), [
      start!, { type: 'reasoning', text: `Thinking about turn ${i}.`, time: { start: t, end: t + 10 } }, ...tools,
      { type: 'text', text: `Turn ${i}: the directory holds file-${i}.txt and README.md.` }, { type: 'patch', hash: `h${i}`, files: [`/workspace/file-${i}.txt`] }, finish!,
    ]));
  }
  return { root, child };
}
