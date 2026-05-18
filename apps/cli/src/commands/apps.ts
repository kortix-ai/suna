import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

const HELP = `Usage: kortix apps <command> [options]

Inspect and deploy the [[apps]] declared in your project's kortix.toml.

Commands:
  list                       Print every app declared in kortix.toml.
  deploy [<slug>]            Manually deploy one app (or all enabled apps
                             when <slug> is omitted) via the Kortix API.
                             Requires KORTIX_API_URL + KORTIX_API_TOKEN
                             and KORTIX_PROJECT_ID env vars.
  -h, --help                 Show this help.

Environment:
  KORTIX_API_URL             Base URL of the Kortix API
                             (e.g. https://api.kortix.com).
  KORTIX_API_TOKEN           Bearer token (Supabase JWT or kortix_ key).
  KORTIX_PROJECT_ID          UUID of the project owning the apps.
  KORTIX_TOML                Path to kortix.toml. Defaults to ./kortix.toml.
`;

interface AppEntry {
  slug: string;
  name?: string;
  enabled?: boolean;
  domains?: string[];
  framework?: string;
  source?: { type?: string; repo?: string; branch?: string; root_path?: string; url?: string };
  build?: { command?: string; out_dir?: string };
  env?: Record<string, string>;
}

function readManifest(): { apps: AppEntry[]; path: string } {
  const path = process.env.KORTIX_TOML
    ? resolve(process.env.KORTIX_TOML)
    : resolve(process.cwd(), 'kortix.toml');
  if (!existsSync(path)) {
    throw new Error(`No kortix.toml found at ${path}. Run \`kortix init\` first or set KORTIX_TOML.`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = parseToml(raw) as Record<string, unknown>;
  const apps = Array.isArray(parsed.apps) ? (parsed.apps as AppEntry[]) : [];
  return { apps, path };
}

function printApp(app: AppEntry, indent = '  '): void {
  const enabled = app.enabled === false ? ' (disabled)' : '';
  const name = app.name ?? app.slug;
  process.stdout.write(`${indent}${app.slug}${enabled}  —  ${name}\n`);
  if (app.framework) process.stdout.write(`${indent}  framework: ${app.framework}\n`);
  process.stdout.write(`${indent}  domains:   ${(app.domains ?? []).join(', ') || '(none)'}\n`);
  if (app.source?.type === 'git') {
    const repo = app.source.repo ?? '(project repo)';
    const branch = app.source.branch ? ` @ ${app.source.branch}` : '';
    const sub = app.source.root_path ? ` /${app.source.root_path}` : '';
    process.stdout.write(`${indent}  source:    git ${repo}${branch}${sub}\n`);
  } else if (app.source?.type === 'tar') {
    process.stdout.write(`${indent}  source:    tar ${app.source.url ?? '(no url)'}\n`);
  } else {
    process.stdout.write(`${indent}  source:    (unspecified)\n`);
  }
  if (app.build?.command) {
    process.stdout.write(`${indent}  build:     ${app.build.command}${app.build.out_dir ? ` → ${app.build.out_dir}` : ''}\n`);
  }
  if (app.env && Object.keys(app.env).length > 0) {
    process.stdout.write(`${indent}  env:       ${Object.keys(app.env).join(', ')}\n`);
  }
}

function runList(): number {
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (manifest.apps.length === 0) {
    process.stdout.write(`No [[apps]] declared in ${manifest.path}.\n`);
    return 0;
  }

  process.stdout.write(`${manifest.apps.length} app(s) in ${manifest.path}:\n\n`);
  for (const app of manifest.apps) printApp(app);
  return 0;
}

async function runDeploy(argv: string[]): Promise<number> {
  const slug = argv[0];
  const baseUrl = process.env.KORTIX_API_URL?.replace(/\/+$/, '');
  const token = process.env.KORTIX_API_TOKEN;
  const projectId = process.env.KORTIX_PROJECT_ID;

  if (!baseUrl) { process.stderr.write('KORTIX_API_URL is required.\n'); return 1; }
  if (!token) { process.stderr.write('KORTIX_API_TOKEN is required.\n'); return 1; }
  if (!projectId) { process.stderr.write('KORTIX_PROJECT_ID is required.\n'); return 1; }

  // Resolve the target slug(s) by reading the local manifest. This lets
  // `kortix apps deploy` (no arg) deploy every enabled app in one shot.
  let targets: string[];
  if (slug) {
    targets = [slug];
  } else {
    try {
      const { apps } = readManifest();
      targets = apps
        .filter((a) => typeof a.slug === 'string' && a.enabled !== false)
        .map((a) => a.slug);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    if (targets.length === 0) {
      process.stdout.write('No enabled apps to deploy.\n');
      return 0;
    }
  }

  let exit = 0;
  for (const target of targets) {
    const url = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(target)}/deploy`;
    process.stdout.write(`→ ${target}: POST ${url}\n`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      process.stderr.write(`  request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      exit = 1;
      continue;
    }
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      process.stderr.write(`  ${res.status} ${res.statusText}: ${typeof body === 'string' ? body : JSON.stringify(body)}\n`);
      exit = 1;
      continue;
    }
    const data = body as { status?: string; deployment?: { live_url?: string; error?: string } };
    process.stdout.write(`  status:   ${data.status ?? 'unknown'}\n`);
    if (data.deployment?.live_url) process.stdout.write(`  live_url: ${data.deployment.live_url}\n`);
    if (data.deployment?.error)    process.stdout.write(`  error:    ${data.deployment.error}\n`);
  }
  return exit;
}

export async function runApps(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list' || sub === 'ls') return runList();
  if (sub === 'deploy') return runDeploy(rest);
  process.stderr.write(`Unknown subcommand: ${sub}\n${HELP}`);
  return 1;
}
