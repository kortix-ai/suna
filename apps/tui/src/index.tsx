/**
 * The standalone entry — `pnpm --filter @kortix/tui dev`.
 *
 * It owns the process, so it is the thin half: resolve the host the same way
 * every `kortix` command does, read the two boot env vars, hand both to
 * `runTui()` (`src/main.tsx`, which is the app), and exit on the code it
 * resolves.
 *
 * The other caller is `kortix tui` (`apps/cli/src/commands/tui.ts`). It builds
 * the same `ResolvedHost` from the CLI's own `--host`/`loadAuth()` and does NOT
 * exit the process — which is why the boot logic lives in `main.tsx` and this
 * file holds nothing but the standalone wiring.
 */

import { resolveHost } from './auth/hosts.ts';
import { runTui } from './main.tsx';

const code = await runTui({
  host: resolveHost(),
  projectId: process.env.KORTIX_PROJECT_ID,
  sessionId: process.env.KORTIX_SESSION_ID,
});

process.exit(code);
