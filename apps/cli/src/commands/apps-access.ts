import type { AppAccessMode } from '@kortix/sdk';

import { emitJson, fail, takeFlagValue } from '../command-helpers.ts';
import { C } from '../style.ts';
import { type ContextOptions, context, csv, resolveApp, scoped } from './apps-deploy.ts';

// `kortix apps access` and `access-link` — who may open an App, and the
// short-lived browser URL that bypasses the check.

export async function accessCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('access needs an App id or slug');
  rest.splice(rest.indexOf(target), 1);
  const mode = takeFlagValue(rest, ['--mode']) as AppAccessMode | undefined;
  if (mode && !['private', 'project', 'restricted', 'public', 'password'].includes(mode)) {
    throw new Error('--mode must be private, project, restricted, public, or password');
  }
  const password = takeFlagValue(rest, ['--password']);
  const memberIds = csv(takeFlagValue(rest, ['--members']));
  const groupIds = csv(takeFlagValue(rest, ['--groups']));
  const viewer = takeFlagValue(rest, ['--viewer']);
  if (viewer !== undefined && !['off', 'identity', 'api'].includes(viewer)) {
    throw new Error('--viewer must be off, identity, or api');
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    let app = await resolveApp(ctx.apps, target);
    // `--viewer` alone keeps the current mode and principals: the route
    // replaces the whole policy, so they are read back and sent again.
    const current = viewer && !mode ? await ctx.apps.access.get(app.app_id) : null;
    const access =
      mode || viewer
        ? await ctx.apps.access.update(app.app_id, {
            mode: mode ?? current!.mode,
            ...(password ? { password } : {}),
            ...(memberIds
              ? { member_ids: memberIds }
              : current
                ? { member_ids: current.member_ids }
                : {}),
            ...(groupIds
              ? { group_ids: groupIds }
              : current
                ? { group_ids: current.group_ids }
                : {}),
            ...(viewer ? { viewer_token_scope: viewer as 'off' | 'identity' | 'api' } : {}),
          })
        : await ctx.apps.access.get(app.app_id);
    if (mode || viewer) app = await ctx.apps.get(app.app_id);
    return { app, access };
  });
  if (json) emitJson(result);
  else {
    process.stdout.write(
      `\n  ${C.bold}${result.app.name}${C.reset}\n  access  ${result.access.mode}\n  viewer  ${result.access.viewer_token_scope}\n`,
    );
    if (result.access.member_ids.length)
      process.stdout.write(`  members ${result.access.member_ids.join(', ')}\n`);
    if (result.access.group_ids.length)
      process.stdout.write(`  groups  ${result.access.group_ids.join(', ')}\n`);
    process.stdout.write('\n');
  }
  return 0;
}

export async function accessLinkCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('access-link needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    const accessSession = await ctx.apps.access.session(app.app_id);
    return { app, access_session: accessSession };
  });
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${C.bold}${result.app.name}${C.reset}\n`);
    process.stdout.write(`  ${result.access_session.url}\n`);
    process.stdout.write(`  ${C.dim}expires ${result.access_session.expires_at}${C.reset}\n\n`);
  }
  return 0;
}
