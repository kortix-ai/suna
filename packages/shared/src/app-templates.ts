/**
 * App templates (Fly `launch`): data, never platform code. A template is the
 * `kortix.yaml` `apps` blocks of a ready-made App, plus what to do after the
 * first deploy. `kortix apps launch --template <name>` writes the blocks and
 * deploys them; the kortix-apps skill documents each one.
 *
 * Every image is pinned by digest: a template never changes under an App.
 */

export interface AppTemplate {
  name: string;
  /** One line for `kortix apps launch --help`. */
  summary: string;
  /** `apps.<slug>` blocks, keyed by slug suffix; `{name}` is the slug the user chose. */
  blocks: (name: string) => Record<string, Record<string, unknown>>;
  /** The order to deploy the blocks in (Apps that others use first). */
  deployOrder: (name: string) => string[];
  /** Project secrets the launch creates once, each right after its App deploys. */
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
const CONVEX_BACKEND = 'ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4';
/** Convex's dashboard image, the same release line. */
const CONVEX_DASHBOARD = 'ghcr.io/get-convex/convex-dashboard@sha256:f85cf0d0448b9c835ae3df5c7c1c6f0145dd4c8f0f92eb0245daf304efdd9f1a';
/** The `convex` npm CLI that matches CONVEX_BACKEND. Bump both together. */
export const CONVEX_CLI_VERSION = '1.46.0';

export const APP_TEMPLATES: Record<string, AppTemplate> = {
  convex: {
    name: 'convex',
    summary: 'A self-hosted Convex backend: data on a volume, the client and HTTP-action services, an admins-only dashboard.',
    blocks: (name) => ({
      [name]: {
        type: 'oci_image',
        image: CONVEX_BACKEND,
        // The supervisor owns the entrypoint; Convex advertises the App's own URLs.
        command: ['sh', '-c', 'cd /convex && CONVEX_CLOUD_ORIGIN=$KORTIX_APP_URL CONVEX_SITE_ORIGIN=$KORTIX_SERVICE_URL_SITE exec ./run_backend.sh'],
        labels: ['backend'],
        // Its root page is a plain-text banner: the card shows an icon, the dashboard tab is the UI.
        display: { preview: 'none' },
        always_on: true,
        vm: { cpu: 1, memory_gb: 1, disk_gb: 10 },
        mounts: [{ source: 'data', destination: '/convex/data', initial_size_gb: 10 }],
        http_service: { internal_port: 3210, access: 'public', checks: [{ type: 'http', path: '/version', grace_period_s: 5 }] },
        services: [{ name: 'site', internal_port: 3211, access: 'public' }],
        env: { DO_NOT_REQUIRE_SSL: '1', DISABLE_BEACON: '1' },
      },
      [`${name}-dashboard`]: {
        type: 'oci_image',
        image: CONVEX_DASHBOARD,
        // The dashboard reaches the backend through this App's own binding: same origin, behind the admins gate.
        command: ['sh', '-c', `cd /app/dashboard-self-hosted && NEXT_PUBLIC_DEPLOYMENT_URL=$KORTIX_APP_URL/_kortix/apps/${name} PORT=6791 HOSTNAME=0.0.0.0 exec node ./server.js`],
        labels: ['backend', 'dashboard'],
        // A tab of the backend's detail, not a card of its own.
        display: { parent: name },
        uses: [name],
        always_on: false,
        vm: { cpu: 1, memory_gb: 1 },
        http_service: { internal_port: 6791, access: 'admins' },
        // Read per request (getInitialProps): the dashboard opens signed in. Only project admins reach it.
        secrets: { NEXT_PUBLIC_ADMIN_KEY: `${slugEnvName(name)}_ADMIN_KEY` },
      },
    }),
    deployOrder: (name) => [name, `${name}-dashboard`],
    secrets: (name) => [
      { name: `${slugEnvName(name)}_ADMIN_KEY`, app: name, command: ['sh', '-c', 'cd /convex && ./generate_admin_key.sh'] },
    ],
    nextSteps: (name) => [
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
