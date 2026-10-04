/**
 * The in-box bash script of the legacy runtime bootstrap and the argv that
 * carries it: render, transport, and the one-JSON-line report the repair
 * state machine parses. The script text itself is the sidecar
 * `legacy-runtime-bootstrap.sh`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProviderName, SandboxExecResult } from '../../platform/providers';

/**
 * The in-box script ships as a sidecar file, not a template literal: bash is
 * full of `${…}` and backticks, and a JS string is the wrong place to review
 * shell. Read once per process; the API image copies src/ wholesale.
 */
let scriptTemplate: string | null = null;
function loadScriptTemplate(): string {
  if (scriptTemplate === null) {
    scriptTemplate = readFileSync(
      fileURLToPath(new URL('./legacy-runtime-bootstrap.sh', import.meta.url)),
      'utf8',
    );
  }
  return scriptTemplate;
}
/** OpenCode home on the box: 'auto' = detect from the running OpenCode / on-disk data (image generations differ). */
const LEGACY_OPENCODE_HOME = 'auto';


export type RelaunchStrategy = 'pt-app' | 'next-start';

/**
 * How a provider re-runs the image entrypoint. Platinum's pt-init launches it
 * once and never again (the VM survives its exit), so the script must relaunch
 * in place. Daytona and E2B run the entrypoint on every sandbox start.
 */
export function relaunchStrategyFor(provider: ProviderName | string): RelaunchStrategy | null {
  switch (provider) {
    case 'platinum':
      return 'pt-app';
    case 'daytona':
    case 'e2b':
      return 'next-start';
    default:
      return null;
  }
}


interface RenderScriptOptions {
  relaunch: RelaunchStrategy;
  opencodeHome?: string;
  /** Seconds the script waits for the relaunched daemon before it restores the legacy chain. */
  healthWaitS?: number;
  /**
   * The entrypoint text, for a box whose API does not serve the `entrypoint`
   * asset yet. The box's own manifest wins whenever it has one.
   */
  entrypointSource?: string;
  /** Fleet pnpm version (packages/shared runtime-versions.json); the script downgrades for an older Node. */
  pnpmVersion?: string;
  /** A freshly minted session PAT to install as the box's KORTIX_TOKEN; empty = keep. */
  kortixToken?: string;
  /**
   * The credential THIS repair authenticates with — minted by the control
   * plane for this run and revoked when it returns. Empty falls the script
   * back to the box's own token, which a wrong row can have already killed.
   */
  repairToken?: string;
}

/**
 * The in-box script. Bash, root, no jq assumed (python3 when present, sed
 * otherwise), no shell evaluation of anything read from the environment.
 * Prints exactly one JSON line on stdout as its last line; everything else
 * goes to stderr and /var/log/kortix-legacy-bootstrap.log.
 */
export function renderLegacyBootstrapScript(opts: RenderScriptOptions): string {
  const opencodeHome = opts.opencodeHome ?? LEGACY_OPENCODE_HOME;
  const healthWaitS = Math.max(30, Math.floor(opts.healthWaitS ?? 150));
  if (opencodeHome !== 'auto' && !/^\/[A-Za-z0-9_./-]+$/.test(opencodeHome)) throw new Error('unsafe opencodeHome');
  const template = loadScriptTemplate();
  const embedded = opts.entrypointSource ? Buffer.from(opts.entrypointSource, 'utf8').toString('base64') : '';
  const pnpmVersion = opts.pnpmVersion ?? '';
  if (!/^[0-9A-Za-z.-]*$/.test(pnpmVersion)) throw new Error('unsafe pnpmVersion');
  const kortixToken = opts.kortixToken ?? '';
  if (!/^(kortix_pat_[A-Za-z0-9_-]+)?$/.test(kortixToken)) throw new Error('unsafe kortixToken');
  const repairToken = opts.repairToken ?? '';
  if (!/^(kortix_pat_[A-Za-z0-9_-]+)?$/.test(repairToken)) throw new Error('unsafe repairToken');
  for (const placeholder of ['__OPENCODE_HOME__', '__RELAUNCH__', '__HEALTH_WAIT_S__', '__ENTRYPOINT_B64__', '__PNPM_VERSION__', '__KORTIX_TOKEN__', '__KORTIX_REPAIR_TOKEN__']) {
    if (!template.includes(placeholder)) throw new Error(`bootstrap script template lacks ${placeholder}`);
  }
  return template
    .replace('__OPENCODE_HOME__', opencodeHome)
    .replace('__RELAUNCH__', opts.relaunch)
    .replace('__HEALTH_WAIT_S__', String(healthWaitS))
    .replace('__ENTRYPOINT_B64__', embedded)
    .replace('__PNPM_VERSION__', pnpmVersion)
    .replace('__KORTIX_TOKEN__', kortixToken)
    .replace('__KORTIX_REPAIR_TOKEN__', repairToken);
}

/** The provider `exec` argv: the script travels base64 so no quoting layer can touch it. */
export function bootstrapExecCommand(script: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return [
    'bash',
    '-c',
    // The script carries the repair PAT and any rotated session token in
    // plaintext, so it is removed whatever the exit status — leaving it behind
    // persists both secrets at a predictable path inside the box.
    `printf '%s' '${b64}' | base64 -d > /tmp/kx-legacy-bootstrap.sh && bash /tmp/kx-legacy-bootstrap.sh; rc=$?; rm -f /tmp/kx-legacy-bootstrap.sh; exit $rc`,
  ];
}

interface ScriptReport {
  ok: boolean;
  stage: string;
  error?: string;
  agent_sha256?: string;
  entrypoint_sha256?: string;
  previous_opencode?: string;
  token_rotated?: boolean;
}

/** The script's last stdout line is its report. Anything else is a transport failure. */
export function parseScriptReport(result: SandboxExecResult): ScriptReport | null {
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed as unknown as ScriptReport;
      }
    } catch {
      /* not the report line */
    }
  }
  return null;
}
