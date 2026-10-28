/**
 * App templates: data, never platform code. A template is the `kortix.yaml`
 * `apps` blocks of a ready-made App, the files its Apps build from, and what
 * to do after the first deploy. `kortix apps launch --template <name>` writes
 * the blocks and files and deploys them; the kortix-apps skill documents each.
 *
 * Every image is pinned by digest: a template never changes under an App.
 */

export interface AppTemplate {
  name: string;
  /** One line for `kortix apps launch --help`. */
  summary: string;
  /** The App slug `launch` uses without `--name`: what the App is, not what runs it. */
  defaultName: string;
  /** `apps.<slug>` blocks; `name` is the slug the user chose. */
  blocks: (name: string) => Record<string, Record<string, unknown>>;
  /** Files the blocks build from, by path from the project root. A file that exists is kept. */
  files?: (name: string) => Record<string, string>;
  /** The order to deploy the blocks in (Apps that others use first). */
  deployOrder: (name: string) => string[];
  /** Project secrets the launch writes, each right after its App deploys. */
  secrets?: (name: string) => AppTemplateSecret[];
  /** Printed after the deploy: the commands that finish the setup. */
  nextSteps: (name: string) => string[];
}

/** A project secret whose value is the last line `command` prints on a machine of the App `app`. */
export interface AppTemplateSecret {
  name: string;
  app: string;
  command: string[];
}

/** `crm-data` → `CRM_DATA`: a slug as an env name. */
export function slugEnvName(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/** The self-hosted Convex backend, git 5c7cb5b (2026-09-28). `/version` answers `unknown`: the digest is the version. */
const CONVEX_BACKEND = 'ghcr.io/convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4';
/** Convex's dashboard image, the same release line. */
const CONVEX_DASHBOARD = 'ghcr.io/convex/convex-dashboard@sha256:f85cf0d0448b9c835ae3df5c7c1c6f0145dd4c8f0f92eb0245daf304efdd9f1a';
/** The `convex` npm CLI that matches CONVEX_BACKEND. Bump both together. */
export const CONVEX_CLI_VERSION = '1.46.0';

/**
 * `apps/<name>/dashboard/start.js`: runs Convex's dashboard and signs it in.
 * String.raw keeps every backslash as written; the file uses no backticks and
 * no `${`, so it embeds verbatim.
 */
const CONVEX_DASHBOARD_START = String.raw`// Runs the Convex dashboard for one backend and signs it in.
//
// Convex's dashboard runs on port 6792. This server, on the App's port 6791,
// serves "/" as a page that frames the dashboard and answers its
// "dashboard-credentials-request" (Convex's embedding protocol) with the admin
// key, so the Kortix Apps page opens it signed in. Every other path goes to
// the dashboard. Only project admins reach this App (access: admins), so the
// page may carry the key. The key is the project secret <NAME>_ADMIN_KEY.
const { spawn } = require('child_process');
const http = require('http');

const backend = process.env.BACKEND;
// The backend through this App's own binding: same origin, behind the same gate.
const deploymentUrl = process.env.KORTIX_APP_URL + '/_kortix/apps/' + backend;
const adminKey = process.env.NEXT_PUBLIC_ADMIN_KEY || '';

const dashboard = spawn('node', ['server.js'], {
  cwd: '/app/dashboard-self-hosted',
  stdio: 'inherit',
  env: { ...process.env, PORT: '6792', HOSTNAME: '127.0.0.1', NEXT_PUBLIC_DEPLOYMENT_URL: deploymentUrl },
});
// One process exits, the machine exits, and Kortix restarts both.
dashboard.on('exit', (code) => process.exit(code ?? 1));

const credentials = JSON.stringify({ type: 'dashboard-credentials', adminKey, deploymentUrl, deploymentName: backend })
  .replace(/</g, '\\u003c');
const page = '<!doctype html><meta charset="utf-8"><title>Convex dashboard</title>'
  + '<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>'
  + '<iframe src="/?embedded=1"></iframe>'
  + '<script>const c=' + credentials + ';addEventListener("message",(e)=>{'
  + 'if(e.origin===location.origin&&e.data&&e.data.type==="dashboard-credentials-request")'
  + 'e.source.postMessage(c,location.origin)})</script>';

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: 6792, path: req.url, method: req.method, headers: req.headers },
    (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}).listen(6791, '0.0.0.0');
`;

const convexDashboardDockerfile = (name: string) => `# The Convex dashboard for the ${name} backend, opened signed in from the Kortix Apps page.
FROM ${CONVEX_DASHBOARD}
ENV BACKEND=${name}
COPY start.js /kortix/start.js
`;

export const APP_TEMPLATES: Record<string, AppTemplate> = {
  convex: {
    name: 'convex',
    // A Convex App is a whole backend (data, functions, realtime, files, schedules), not a database.
    defaultName: 'backend',
    summary: 'A self-hosted Convex backend: data on a volume, the client and HTTP-action services, and an admins-only dashboard tab.',
    blocks: (name) => ({
      [name]: {
        type: 'oci_image',
        image: CONVEX_BACKEND,
        // Convex advertises the App's own URLs to its clients.
        command: ['sh', '-c', 'cd /convex && CONVEX_CLOUD_ORIGIN=$KORTIX_APP_URL CONVEX_SITE_ORIGIN=$KORTIX_SERVICE_URL_SITE exec ./run_backend.sh'],
        labels: ['backend'],
        // Its root page is a plain-text banner: an icon card; the Dashboard tab is the UI.
        display: { preview: 'none' },
        always_on: true,
        vm: { cpu: 1, memory_gb: 1, disk_gb: 10 },
        mounts: [{ source: 'data', destination: '/convex/data', initial_size_gb: 10 }],
        http_service: { internal_port: 3210, access: 'public', checks: [{ type: 'http', path: '/version', grace_period_s: 5 }] },
        services: [{ name: 'site', internal_port: 3211, access: 'public' }],
        env: { DO_NOT_REQUIRE_SSL: '1', DISABLE_BEACON: '1' },
      },
      [`${name}-dashboard`]: {
        path: `apps/${name}/dashboard`,
        type: 'dockerfile',
        command: ['node', '/kortix/start.js'],
        labels: ['backend', 'dashboard'],
        // A tab of the backend's detail, not a card of its own.
        display: { parent: name },
        uses: [name],
        always_on: false,
        vm: { cpu: 1, memory_gb: 1 },
        http_service: { internal_port: 6791, access: 'admins' },
        secrets: { NEXT_PUBLIC_ADMIN_KEY: `${slugEnvName(name)}_ADMIN_KEY` },
      },
    }),
    files: (name) => ({
      [`apps/${name}/dashboard/Dockerfile`]: convexDashboardDockerfile(name),
      [`apps/${name}/dashboard/start.js`]: CONVEX_DASHBOARD_START,
    }),
    deployOrder: (name) => [name, `${name}-dashboard`],
    // Derived from the backend's instance secret: rewritten on every launch, the same value while the volume lives.
    secrets: (name) => [
      { name: `${slugEnvName(name)}_ADMIN_KEY`, app: name, command: ['sh', '-c', 'cd /convex && ./generate_admin_key.sh'] },
    ],
    nextSteps: (name) => [
      `mkdir -p apps/${name} && cd apps/${name} && npm i convex@${CONVEX_CLI_VERSION}   # the App's code: apps/${name}/convex (any folder works; this is the default)`,
      `export CONVEX_SELF_HOSTED_URL=<${name} URL> CONVEX_SELF_HOSTED_ADMIN_KEY="$${slugEnvName(name)}_ADMIN_KEY"   # in apps/${name}, for the convex CLI (a session has the secret in its env)`,
      `kortix apps auth-env ${name} | while IFS='=' read -r k v; do printf '%s' "$v" | npx convex env set "$k"; done   # Kortix sign-in`,
      `npx convex@${CONVEX_CLI_VERSION} deploy   # push your functions (convex/auth.config.ts: the kortix-apps skill, sign-in)`,
      `Apps tab → ${name} → Dashboard   # the Convex dashboard, signed in (project admins)`,
    ],
  },
};

export function appTemplate(name: string): AppTemplate | null {
  return APP_TEMPLATES[name] ?? null;
}
