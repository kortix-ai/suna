#!/usr/bin/env bun
/**
 * secrets — request project secret VALUES from the human via a short-lived link.
 *
 * You never see (and never need to paste into chat) the raw value. You name the
 * secret(s); this mints a link the human opens to type the value in. SURFACE the
 * returned url in your reply — in the web UI it opens a fill-in modal, in Slack
 * it's a tappable link. Once submitted, a `runtime` secret shows up in your
 * session env (see KORTIX_PROJECT_SECRET_NAMES); a `connector` secret stays
 * server-side. This is also exposed as the `request_secret` tool on the
 * `kortix-executor` MCP — prefer whichever fits your flow.
 *
 * Usage:
 *   secrets request APOLLO_API_KEY                       # one key, runtime scope
 *   secrets request APOLLO_API_KEY SMARTLEAD_API_KEY     # several on one link
 *   secrets request STRIPE_API_KEY --scope connector     # server-side only
 *   secrets request FOO_API_KEY --expires 60             # 60-minute link
 */
import { parseArgs, out, handleError, CliError, mintSecretLink } from './lib';

export async function main(argv = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);

  switch (command) {
    case 'request':
    case 'ask': {
      const names = args.map((a) => a.toUpperCase()).filter(Boolean);
      if (names.length === 0) {
        throw new CliError('usage: secrets request <NAME> [<NAME>...] [--scope runtime|connector] [--expires <minutes>]', 'USAGE');
      }
      const scope = flags.scope === 'connector' ? 'connector' : 'runtime';
      const expires = flags.expires ? Number(flags.expires) : undefined;
      const link = await mintSecretLink({ names, scope, expiresInMinutes: expires });
      out({
        ok: true,
        names: link.names,
        scope: link.scope,
        url: link.url,
        expires_at: link.expires_at,
        note: 'Surface this url to the human. They open it to enter the value (web: modal, Slack: link). You never see the value.',
      });
      break;
    }

    default:
      out({
        name: 'secrets',
        description: 'Request project secret values from the human via a short-lived fill-in link. You never see the value.',
        commands: {
          request: 'secrets request <NAME> [<NAME>...] [--scope runtime|connector] [--expires <minutes>] — mint a link to hand the human',
        },
      });
  }
}

if (import.meta.main) {
  main().catch(handleError);
}
