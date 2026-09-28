/**
 * `kortix mcp` — the Kortix CLI as a stdio MCP server.
 *
 * One tool per top-level command in the help table (`command-table.ts`), so the
 * MCP surface is the CLI surface by construction: a command added to the CLI
 * is a tool here without a second edit. A call runs the real binary as a child
 * process — same auth (`kortix login` or KORTIX_TOKEN), same host, same
 * output. The child's stdout is a pipe, so the CLI's own non-TTY rules apply:
 * no color, no prompts, no update question.
 *
 * STDOUT IS THE JSON-RPC CHANNEL — nothing else may be written there.
 */
import { TIERS } from './command-table.ts';

// Commands that take over a terminal or replace the binary. Everything else is
// a tool.
const EXCLUDED = new Set(['mcp', 'connect', 'tui', 'update', 'uninstall', 'help']);

const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 3600;

const SERVER_INFO = { name: 'kortix', version: process.env.KORTIX_CLI_VERSION ?? 'dev' };

const INSTRUCTIONS =
  'Each tool runs one Kortix CLI command: tool `sessions` with args ["ls","--json"] runs ' +
  '`kortix sessions ls --json`. New to Kortix? Call `system-skills` with no args first, then ' +
  '`system-skills` ["get","<name>"]. Pass ["--help"] (or ["<subcommand>","--help"]) to read a ' +
  "command's flags. Prefer --json where a command supports it. Auth is the CLI's: " +
  '`kortix login` on this machine, or KORTIX_TOKEN in the server env.';

export const MCP_TOOLS = TIERS.flatMap((tier) => tier.sections.flatMap((s) => s.commands))
  .filter((cmd) => !EXCLUDED.has(cmd.name))
  .map((cmd) => ({
    name: cmd.name,
    description: `${cmd.blurb}. Runs \`kortix ${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}\`; pass ["--help"] for its subcommands and flags.`,
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: `Arguments after \`kortix ${cmd.name}\`, one element per argv entry, e.g. ["ls","--json"].`,
        },
        stdin: {
          type: 'string',
          description: 'Text piped to the command, for arguments given as `-`.',
        },
        timeout_seconds: {
          type: 'number',
          description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
        },
      },
      additionalProperties: false,
    },
  }));

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

/** How this process was started, so a child runs the same build. */
function selfArgv(): string[] {
  const entrypoint = process.argv[1];
  if (entrypoint && /\.[cm]?[jt]sx?$/.test(entrypoint) && /bun/i.test(process.execPath)) {
    return [process.execPath, entrypoint];
  }
  return [process.execPath];
}

type JsonRpcId = string | number;
interface JsonRpcRequest {
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
}

const running = new Map<JsonRpcId, Bun.Subprocess>();

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  id?: JsonRpcId,
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  if (!TOOL_NAMES.has(name)) return fail(`unknown tool ${name}`);
  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return fail('args must be an array of strings');
  }
  const stdin = typeof input.stdin === 'string' ? input.stdin : undefined;
  const timeoutS = Math.min(Number(input.timeout_seconds) || DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);

  const proc = Bun.spawn([...selfArgv(), name, ...args], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', KORTIX_NO_UPDATE_PROMPT: '1' },
  });
  if (id !== undefined) running.set(id, proc);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutS * 1000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (id !== undefined) running.delete(id);

  // stdout alone in the first block, so --json output stays parseable; the
  // CLI writes its host line and errors to stderr.
  const parts = [stdout.trimEnd() || '(no stdout)'];
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  if (timedOut) parts.push(`[killed after ${timeoutS}s; raise timeout_seconds]`);
  else if (code !== 0) parts.push(`[exit code ${code}]`);
  return {
    content: parts.map((text) => ({ type: 'text' as const, text })),
    isError: timedOut || code !== 0,
  };
}

async function handle(req: JsonRpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: MCP_TOOLS };
    case 'tools/call':
      return runTool(
        String(req.params?.name ?? ''),
        (req.params?.arguments as Record<string, unknown>) ?? {},
        req.id ?? undefined,
      );
    case 'notifications/cancelled':
      running.get(req.params?.requestId as JsonRpcId)?.kill();
      return undefined;
    default:
      if (req.method?.startsWith('notifications/')) return undefined;
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}

function write(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
}

/** Serve JSON-RPC on stdio until stdin closes. Calls run concurrently. */
export async function runMcpServer(): Promise<number> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      const id = req.id;
      handle(req).then(
        (result) => {
          if (id !== undefined && id !== null) write({ id, result });
        },
        (err: Error & { code?: number }) => {
          if (id !== undefined && id !== null) {
            write({ id, error: { code: err.code ?? -32000, message: err.message } });
          }
        },
      );
    }
  }
  // The client went away: stop what it started instead of orphaning it.
  for (const proc of running.values()) proc.kill();
  return 0;
}
