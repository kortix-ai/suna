import type { App, AppCapability } from '@kortix/sdk';
import { APP_CONNECT_TABS, type AppConnectTab, appConnectSnippets } from '@kortix/shared/app-connect';

import { emitJson, fail, takeFlagValue } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import { context, resolveApp, scoped, type ContextOptions } from './apps-deploy.ts';

// The `kortix apps` subcommands gated by one capability (`token`: member_tokens),
// plus `connect` and links (`uses`). The CLI branches on capabilities.

type Ctx = NonNullable<Awaited<ReturnType<typeof context>>>;

/** Throws, in the words the API uses, when the App lacks `capability`. */
export function requireCapability(app: App, capability: AppCapability): void {
  if (app.capabilities?.includes(capability)) return;
  throw new Error(`App ${app.slug} does not support ${capability.replaceAll('_', ' ')}.`);
}

/** Resolve the App named by `target` and check it has `capability`. */
async function capableApp(ctx: Ctx, target: string, capability: AppCapability): Promise<App> {
  const app = await scoped(ctx, () => resolveApp(ctx.apps, target));
  requireCapability(app, capability);
  return app;
}

const firstArgs = (rest: string[]) => rest.filter((value) => !value.startsWith('-'));

export async function tokenCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('token needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await capableApp(ctx, target, 'member_tokens');
  const minted = await scoped(ctx, () => ctx.apps.token(app.app_id));
  if (json) emitJson(minted);
  else process.stdout.write(`${minted.token}\n`);
  return 0;
}

const CONNECT_HEADINGS: Record<AppConnectTab, string> = {
  app: 'App: code of a Kortix App that uses this one',
  outside: 'From outside: scripts, services and your own servers',
};

/** The Connect dialog as text: per tab a heading, then each snippet's file and title, then its code as is. */
export function renderConnect(app: App): string {
  const snippets = appConnectSnippets(app);
  let out = `\n${C.bold}${app.slug}${C.reset}  ${app.url}\n${C.dim}uses: ${app.uses?.length ? app.uses.join(', ') : 'none'}${C.reset}\n`;
  for (const tab of APP_CONNECT_TABS) {
    const rows = snippets.filter((row) => row.tab === tab);
    if (rows.length === 0) continue;
    out += `\n${C.bold}${CONNECT_HEADINGS[tab]}${C.reset}\n`;
    for (const snippet of rows) out += `\n${C.dim}# ${snippet.file} · ${snippet.title}${C.reset}\n${snippet.code}\n`;
  }
  return `${out}\n`;
}

export async function connectCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = firstArgs(rest);
  if (!target) return fail('connect needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, () => resolveApp(ctx.apps, target));
  if (json) {
    emitJson({ app: { app_id: app.app_id, slug: app.slug, url: app.url, auth: app.auth ?? null }, snippets: appConnectSnippets(app) });
    return 0;
  }
  process.stdout.write(renderConnect(app));
  return 0;
}

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `--uses a,b`: trimmed, deduplicated App slugs; `--uses=` is the empty list. */
export function usesList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const slugs = [...new Set(value.split(',').map((slug) => slug.trim()).filter(Boolean))];
  const bad = slugs.find((slug) => !APP_SLUG.test(slug));
  if (bad) throw new Error(`--uses: "${bad}" is not an App slug (lowercase letters, numbers and single hyphens)`);
  return slugs;
}

/** `link <app> --uses a,b` adds to the Apps it uses; `unlink` removes them. */
export async function linkCommand(
  action: 'link' | 'unlink',
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const given = usesList(takeFlagValue(rest, ['--uses']));
  const [target] = firstArgs(rest);
  if (!target || !given?.length) return fail(`${action} needs an App and --uses <slugs>`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    const current = found.uses ?? [];
    const uses = action === 'link'
      ? [...new Set([...current, ...given])]
      : current.filter((slug) => !given.includes(slug));
    return ctx.apps.update(found.app_id, { uses });
  });
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`${app.slug} uses ${app.uses?.length ? app.uses.join(', ') : 'no App'}`)}\n\n`);
  return 0;
}

/**
 * The order to deploy a manifest's Apps in: every App after the Apps it uses
 * (`uses` within the manifest), then by name. A use of an App outside the
 * manifest does not constrain the order. A cycle throws.
 */
export function deployOrder(blocks: Record<string, { uses?: string[] }>): string[] {
  const pending = new Set(Object.keys(blocks));
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((name) => (blocks[name]!.uses ?? []).every((used) => !pending.has(used) || used === name))
      .sort();
    if (ready.length === 0) {
      throw new Error(`kortix.yaml apps use each other in a cycle: ${[...pending].sort().join(', ')}`);
    }
    order.push(ready[0]!);
    pending.delete(ready[0]!);
  }
  return order;
}
