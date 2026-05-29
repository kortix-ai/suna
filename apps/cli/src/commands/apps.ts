import { ApiError } from '../api/client.ts';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// ── Shapes (mirror apps/api/src/projects apps routes) ───────────────────────

interface AppDeployment {
  deployment_id: string;
  status: 'pending' | 'active' | 'failed' | 'stopped';
  live_url: string | null;
  error: string | null;
  version: number;
  updated_at: string;
}

interface ProjectApp {
  slug: string;
  name: string;
  enabled: boolean;
  domains: string[];
  framework: string | null;
  source: { type: string; repo?: string | null; branch?: string | null; root_path?: string | null; url?: string };
  build: { command: string | null; out_dir: string | null } | null;
  env: Record<string, string>;
  latest_deployment: AppDeployment | null;
  drift: boolean;
}

const HELP = `Usage: kortix apps <subcommand> [options]

Manage deployable apps (experimental) — mirrors the dashboard's Apps surface.
Apps are declared in \`[[apps]]\` in kortix.toml and deployed to a provider
(Freestyle). Requires the platform flag KORTIX_APPS_EXPERIMENTAL.

Subcommands:
  ls                                List apps + latest deployment status.
  add <slug> --repo <url> [...]     Create an app in kortix.toml.
  update <slug> [...]               Update an app's fields.
  rm <slug>                         Remove an app from the manifest.
  deploy <slug>                     Deploy now (bypasses the drift check).
  stop <slug>                       Tear down the latest deployment.
  logs <slug>                       Fetch provider logs for the latest deploy.

Add/update options:
  --name <label>           Display name.
  --framework <f>          e.g. next, vite, static.
  --repo <url>             Git source repo (source.type=git).
  --branch <b>             Git branch.
  --root-path <p>          Subdir inside the repo to deploy.
  --tar <url>              Tarball source (source.type=tar) — alt to --repo.
  --build-command <cmd>    Build command.
  --out-dir <dir>          Build output directory.
  --domains <d,d>          Custom domains (comma-separated).
  --disable                Set enabled=false (default enabled).

Global:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

export async function runApps(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let disable = false;
  try {
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.name = takeFlagValue(rest, ['--name']);
    f.framework = takeFlagValue(rest, ['--framework']);
    f.repo = takeFlagValue(rest, ['--repo']);
    f.branch = takeFlagValue(rest, ['--branch']);
    f.rootPath = takeFlagValue(rest, ['--root-path']);
    f.tar = takeFlagValue(rest, ['--tar']);
    f.buildCommand = takeFlagValue(rest, ['--build-command']);
    f.outDir = takeFlagValue(rest, ['--out-dir']);
    f.domains = takeFlagValue(rest, ['--domains']);
    disable = takeFlagBool(rest, ['--disable']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/apps`;

  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (f.name) body.name = f.name;
    if (f.framework) body.framework = f.framework;
    if (disable) body.enabled = false;
    if (f.domains) body.domains = f.domains.split(',').map((s) => s.trim()).filter(Boolean);
    if (f.tar) {
      body.source = { type: 'tar', url: f.tar };
    } else if (f.repo || f.branch || f.rootPath) {
      body.source = { type: 'git', repo: f.repo ?? null, branch: f.branch ?? null, root_path: f.rootPath ?? null };
    }
    if (f.buildCommand || f.outDir) {
      body.build = { command: f.buildCommand ?? null, out_dir: f.outDir ?? null };
    }
    return body;
  };

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const resp = await ctx.client.get<{ apps: ProjectApp[]; errors: { slug: string; error: string }[] }>(base);
        for (const e of resp.errors) process.stderr.write(`  ${status.warn(`${e.slug}: ${e.error}`)}\n`);
        if (resp.apps.length === 0) {
          process.stdout.write(`  ${C.dim}No apps. Add one: ${C.reset}${C.cyan}kortix apps add <slug> --repo <url> --framework next${C.reset}\n`);
          return 0;
        }
        const slugW = Math.max(...resp.apps.map((a) => a.slug.length), 4);
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}${pad('SLUG', slugW)}   STATUS      FRAMEWORK   URL${C.reset}\n`);
        for (const a of resp.apps) {
          const dep = a.latest_deployment;
          const st = dep ? deployStatus(dep.status) : `${C.faded}none      ${C.reset}`;
          const url = dep?.live_url ?? '';
          const drift = a.drift ? ` ${C.yellow}(drift)${C.reset}` : '';
          process.stdout.write(`  ${pad(a.slug, slugW)}   ${st}  ${pad(a.framework ?? '—', 9)}  ${C.cyan}${url}${C.reset}${drift}\n`);
        }
        process.stdout.write(`\n  ${C.dim}${resp.apps.length} app${resp.apps.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }
      case 'add':
      case 'create': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        if (!f.repo && !f.tar) return missing('--repo <url> or --tar <url>');
        const body = buildBody();
        body.slug = slug;
        await ctx.client.post(base, body);
        process.stdout.write(`${status.ok(`App ${C.bold}${slug}${C.reset} written to kortix.toml`)}\n`);
        process.stdout.write(`  ${C.dim}Deploy it: ${C.reset}${C.cyan}kortix apps deploy ${slug}${C.reset}\n`);
        return 0;
      }
      case 'update':
      case 'edit': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        const body = buildBody();
        if (Object.keys(body).length === 0) return missing('at least one field to update');
        await ctx.client.patch(`${base}/${encodeURIComponent(slug)}`, body);
        process.stdout.write(`${status.ok(`Updated ${C.bold}${slug}${C.reset}`)}\n`);
        return 0;
      }
      case 'rm':
      case 'remove':
      case 'delete': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        await ctx.client.delete(`${base}/${encodeURIComponent(slug)}`);
        process.stdout.write(`${status.ok(`Removed ${C.bold}${slug}${C.reset}`)} ${C.dim}(running deployment is left alone — use \`stop\`)${C.reset}\n`);
        return 0;
      }
      case 'deploy': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        process.stdout.write(`  ${C.dim}Deploying ${slug}…${C.reset}\n`);
        const resp = await ctx.client.post<{ status: string; deployment: AppDeployment | null }>(
          `${base}/${encodeURIComponent(slug)}/deploy`,
        );
        if (resp.status === 'active') {
          process.stdout.write(`${status.ok(`Deployed ${C.bold}${slug}${C.reset}${resp.deployment?.live_url ? ` → ${C.cyan}${resp.deployment.live_url}${C.reset}` : ''}`)}\n`);
          return 0;
        }
        process.stderr.write(`${status.err(`Deploy ${resp.status}${resp.deployment?.error ? `: ${resp.deployment.error}` : ''}`)}\n`);
        return 1;
      }
      case 'stop': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        await ctx.client.post(`${base}/${encodeURIComponent(slug)}/stop`);
        process.stdout.write(`${status.ok(`Stopped ${C.bold}${slug}${C.reset}`)}\n`);
        return 0;
      }
      case 'logs': {
        const slug = positional[0];
        if (!slug) return missing('an app slug');
        const resp = await ctx.client.get<{ ok: boolean; data?: unknown; error?: string }>(
          `${base}/${encodeURIComponent(slug)}/logs`,
        );
        if (!resp.ok) {
          process.stderr.write(`${status.err(resp.error ?? 'No logs available.')}\n`);
          return 1;
        }
        process.stdout.write(`${typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data, null, 2)}\n`);
        return 0;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    // The experimental gate rejects every apps route — give a clear, actionable message.
    if (err instanceof ApiError && /experimental/i.test(err.message)) {
      process.stderr.write(
        `${status.warn('Apps are experimental and disabled on this host.')}\n` +
          `  ${C.dim}Enable with ${C.reset}${C.cyan}KORTIX_APPS_EXPERIMENTAL=true${C.reset}${C.dim} on the API.${C.reset}\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }
}

function deployStatus(s: AppDeployment['status']): string {
  const color = s === 'active' ? C.green : s === 'failed' ? C.red : s === 'stopped' ? C.faded : C.yellow;
  return `${color}${pad(s, 10)}${C.reset}`;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
