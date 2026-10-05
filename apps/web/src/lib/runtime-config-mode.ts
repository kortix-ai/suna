/**
 * Where the public runtime config (`window.__KORTIX_RUNTIME_CONFIG`) comes from.
 *
 * - Vercel: the build and every runtime share one project environment, so the
 *   root layout reads it at build time. Marketing pages then prerender as
 *   static HTML. A changed variable ships with the next deployment, like every
 *   `NEXT_PUBLIC_*` value already does on Vercel.
 * - Standalone (Docker, self-host, ECS): one image serves many environments
 *   and is configured by the container environment at start. The root layout
 *   calls `connection()`, so every page renders per request and reads
 *   `process.env` then. `/api/runtime-config` is request-time in both modes.
 *
 * `VERCEL=1` is set by the platform during the build and at runtime.
 */
export function runtimeConfigIsBakedAtBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return Reflect.get(env, 'VERCEL') === '1';
}
