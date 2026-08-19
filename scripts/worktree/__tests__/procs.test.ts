import { describe, expect, test } from 'bun:test';
import {
  type ProcRow,
  ancestorsOf,
  executableOf,
  expandTree,
  isDevStackProcess,
  isUnder,
  parseLsofCwd,
  parsePsTable,
  planKill,
  sidecarPids,
  stackPids,
} from '../lib';

/**
 * A real stack, as `ps` sees it: `pnpm dev` forks a dotenvx wrapper, which forks the
 * dev server, which forks its worker pool. Only the LEAF binds the port — which is
 * why "kill whatever holds the port" reclaimed 3 of ~19 processes and leaked the rest.
 */
const WT = '/Users/dev/Projects/kortix/suna-featurex';
const STACK: ProcRow[] = [
  { pid: 100, ppid: 1, command: 'bun scripts/worktree/cli.ts start featurex' },
  { pid: 200, ppid: 100, command: 'pnpm --filter kortix-api dev' },
  { pid: 201, ppid: 200, command: 'node dotenvx.js run -- bun run --hot src/index.ts' },
  { pid: 202, ppid: 201, command: 'bun run --hot src/index.ts' },
  { pid: 300, ppid: 100, command: 'pnpm --filter Kortix-Computer-Frontend dev' },
  { pid: 301, ppid: 300, command: 'node next dev' },
  { pid: 302, ppid: 301, command: 'node next-server' },
  { pid: 303, ppid: 302, command: 'node .next/webpack-loaders.js 1' },
  { pid: 304, ppid: 302, command: 'node .next/webpack-loaders.js 2' },
  { pid: 305, ppid: 302, command: 'node .next/postcss.js' },
  { pid: 306, ppid: 301, command: 'esbuild --service' },
  { pid: 400, ppid: 1, command: 'cloudflared tunnel --no-autoupdate --url http://localhost:18508' },
  {
    pid: 401,
    ppid: 1,
    command: 'stripe listen --forward-to http://localhost:18508/v1/billing/webhooks/stripe',
  },
  { pid: 999, ppid: 1, command: '/Applications/Ghostty.app/Contents/MacOS/ghostty' },
];

describe('parsePsTable', () => {
  test('splits pid/ppid off a command that itself contains spaces and digits', () => {
    const rows = parsePsTable(
      '  501   1 /usr/bin/foo --port 8008 --x 2\n 502 501 bun run --hot src/index.ts\n',
    );
    expect(rows).toEqual([
      { pid: 501, ppid: 1, command: '/usr/bin/foo --port 8008 --x 2' },
      { pid: 502, ppid: 501, command: 'bun run --hot src/index.ts' },
    ]);
  });

  test('ignores header junk and blank lines', () => {
    expect(parsePsTable('\n  PID PPID COMMAND\n\n 7 1 x\n')).toEqual([
      { pid: 7, ppid: 1, command: 'x' },
    ]);
  });
});

describe('parseLsofCwd', () => {
  test('pairs each -Fp pid record with the -Fn path that follows it', () => {
    expect(parseLsofCwd('p100\nn/a/b\np200\nn/c\n')).toEqual([
      { pid: 100, cwd: '/a/b' },
      { pid: 200, cwd: '/c' },
    ]);
  });

  test('drops path records that arrive before any pid', () => {
    expect(parseLsofCwd('n/orphaned\np5\nn/real\n')).toEqual([{ pid: 5, cwd: '/real' }]);
  });
});

describe('isUnder', () => {
  test('matches the directory itself and anything beneath it', () => {
    expect(isUnder('/w/suna-x', '/w/suna-x')).toBe(true);
    expect(isUnder('/w/suna-x/apps/web', '/w/suna-x')).toBe(true);
  });

  test('respects segment boundaries so one worktree never reaps another', () => {
    expect(isUnder('/w/suna-xyz', '/w/suna-x')).toBe(false);
    expect(isUnder('/w/suna-x-old/apps/api', '/w/suna-x')).toBe(false);
  });

  test('tolerates a trailing slash on the directory', () => {
    expect(isUnder('/w/suna-x/apps', '/w/suna-x/')).toBe(true);
  });
});

describe('expandTree', () => {
  test('a supervisor root reaches every descendant, not just its direct children', () => {
    expect(expandTree([100], STACK).sort((a, b) => a - b)).toEqual([
      100, 200, 201, 202, 300, 301, 302, 303, 304, 305, 306,
    ]);
  });

  test('THE REGRESSION: the port-holding leaf is not the tree — killing it leaves the rest alive', () => {
    const portHolder = 302;
    const fromLeaf = expandTree([portHolder], STACK);
    const fromRoot = expandTree([100], STACK);
    expect(fromLeaf).not.toContain(300);
    expect(fromLeaf).not.toContain(202);
    expect(fromRoot.length).toBeGreaterThan(fromLeaf.length);
  });

  test('never escapes into unrelated processes', () => {
    expect(expandTree([100], STACK)).not.toContain(999);
  });

  test('is cycle-safe against a self-parenting or looping ps snapshot', () => {
    const looped: ProcRow[] = [
      { pid: 1, ppid: 1, command: 'launchd' },
      { pid: 2, ppid: 3, command: 'a' },
      { pid: 3, ppid: 2, command: 'b' },
    ];
    expect(expandTree([2], looped).sort()).toEqual([2, 3]);
  });

  test('deduplicates overlapping roots', () => {
    expect(expandTree([100, 300, 302], STACK).filter((p) => p === 302)).toHaveLength(1);
  });
});

describe('ancestorsOf', () => {
  test('walks the parent chain and stops at init', () => {
    expect(ancestorsOf(303, STACK)).toEqual([302, 301, 300, 100]);
  });

  test('returns nothing for a process parented by init', () => {
    expect(ancestorsOf(100, STACK)).toEqual([]);
  });
});

describe('planKill — the safety envelope', () => {
  test('expands roots to the whole tree', () => {
    expect(planKill({ roots: [100], rows: STACK, selfPid: 999 })).toContain(303);
  });

  test('refuses to sweep a tree it is running inside — self-preservation beats completeness', () => {
    expect(planKill({ roots: [100], rows: STACK, selfPid: 302 })).toEqual([]);
  });

  test('sparing that tree does not spare unrelated roots in the same sweep', () => {
    expect(planKill({ roots: [100, 400], rows: STACK, selfPid: 302 })).toEqual([400]);
  });

  test('never signals an ancestor of the reaper — that would kill the shell it was typed into', () => {
    const plan = planKill({ roots: [100], rows: STACK, selfPid: 303 });
    for (const pid of [302, 301, 300, 100]) expect(plan).not.toContain(pid);
  });

  test('never descends through the reaper into its own subprocesses', () => {
    const rows: ProcRow[] = [
      { pid: 500, ppid: 1, command: 'bun scripts/worktree/cli.ts stop featurex' },
      { pid: 501, ppid: 500, command: 'ps -Ao pid=,ppid=,command=' },
    ];
    expect(planKill({ roots: [500], rows, selfPid: 500 })).toEqual([]);
  });

  test('but a supervisor CAN kill the servers it spawned, passed in as explicit roots', () => {
    const plan = planKill({ roots: [200, 300], rows: STACK, selfPid: 100 });
    expect(plan).toContain(202);
    expect(plan).toContain(303);
    expect(plan).not.toContain(100);
  });

  test('never signals init or pid 0', () => {
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, command: 'launchd' },
      { pid: 2, ppid: 1, command: 'x' },
    ];
    const plan = planKill({ roots: [1, 0, 2], rows, selfPid: 500 });
    expect(plan).toEqual([2]);
  });
});

describe('sidecarPids', () => {
  test('finds the tunnel and stripe forwarder, which run from the CLI cwd and so evade the cwd probe', () => {
    expect(sidecarPids(STACK, 18508).sort()).toEqual([400, 401]);
  });

  test('a shorter port is not a prefix match for a longer one', () => {
    expect(sidecarPids(STACK, 1850)).toEqual([]);
  });

  test('ignores non-sidecar processes that merely mention the port', () => {
    const rows: ProcRow[] = [{ pid: 5, ppid: 1, command: 'curl http://localhost:18508/health' }];
    expect(sidecarPids(rows, 18508)).toEqual([]);
  });
});

describe('isDevStackProcess', () => {
  test('recognises the toolchain a stack is actually made of', () => {
    for (const cmd of [
      'pnpm --filter kortix-api dev',
      'bun run --hot src/index.ts',
      `node ${WT}/apps/web/.next/webpack-loaders.js 42`,
      'esbuild --service',
      'node dotenvx.js run -- x',
    ])
      expect(isDevStackProcess(cmd), cmd).toBe(true);
  });

  test('THE PIPELINE BUG: things that merely share the worktree cwd are not stack roots', () => {
    for (const cmd of [
      'grep -v ^>',
      'tail -20',
      '/bin/zsh',
      'git status',
      'vim src/x.ts',
      'claude --resume',
      'codex exec',
    ])
      expect(isDevStackProcess(cmd), cmd).toBe(false);
  });

  test('only argv[0] counts — a shell whose ARGUMENTS mention node is still just a shell', () => {
    expect(isDevStackProcess('/bin/zsh -c cd /w/suna-x && nohup node fake.js 18508')).toBe(false);
    expect(isDevStackProcess('bash -lc "pnpm dev"')).toBe(false);
  });
});

describe('executableOf', () => {
  test('strips the directory and the arguments', () => {
    expect(executableOf('/Users/dev/.nvm/versions/node/v22/bin/node -e code')).toBe('node');
    expect(executableOf('  pnpm --filter x dev  ')).toBe('pnpm');
    expect(executableOf('')).toBe('');
  });
});

describe('stackPids', () => {
  const cwds = [
    { pid: 200, cwd: `${WT}/apps/api` },
    { pid: 302, cwd: `${WT}/apps/web` },
    { pid: 999, cwd: '/Users/dev/Projects/kortix/suna' },
  ];

  test('reports the full footprint — cwd owners, their descendants, and the sidecars', () => {
    expect(stackPids(WT, 18508, { rows: STACK, cwds }, 500).sort((a, b) => a - b)).toEqual([
      200, 201, 202, 302, 303, 304, 305, 400, 401,
    ]);
  });

  test('counts what `stop` would actually reap, not just the roots', () => {
    const roots = [200, 302, 400, 401];
    expect(stackPids(WT, 18508, { rows: STACK, cwds }, 500).length).toBeGreaterThan(roots.length);
  });

  test('leaves the primary checkout alone', () => {
    expect(stackPids(WT, 18508, { rows: STACK, cwds }, 500)).not.toContain(999);
  });

  test('does not count a shell pipeline running inside the worktree', () => {
    const rows: ProcRow[] = [...STACK, { pid: 700, ppid: 1, command: 'grep -v ^>' }];
    const withPipeline = [...cwds, { pid: 700, cwd: WT }];
    expect(stackPids(WT, 18508, { rows, cwds: withPipeline }, 500)).not.toContain(700);
  });

  test('excludes the caller and its ancestors, so `doctor` run inside a worktree never counts itself', () => {
    const pids = stackPids(WT, 18508, { rows: STACK, cwds }, 302);
    expect(pids).not.toContain(302);
    expect(pids).toContain(200);
  });

  test('reports nothing for a stack that is genuinely down', () => {
    expect(stackPids('/w/suna-idle', 19999, { rows: STACK, cwds }, 500)).toEqual([]);
  });
});
